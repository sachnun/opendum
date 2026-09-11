package proxy

import (
	"context"
	"errors"
	"math"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/opendum/opendum/apps/proxy/internal/auth"
	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
	"github.com/opendum/opendum/apps/proxy/internal/sessionaffinity"
)

const (
	failedCooldown                     = 10 * time.Minute
	unhealthyIdleDecayInterval         = 10 * time.Minute
	modelDegradedThreshold             = 2
	accountCooldownUnhealthyThreshold  = 10
	cooldownRecoveryRatio              = 0.30
	maxStoredErrorLen                  = 10000
	providerModelAuthlessAccountPrefix = "authless:"
)

func isSyntheticProviderAccountID(accountID string) bool {
	return auth.IsAuthlessProvider(accountID) || strings.HasPrefix(accountID, providerModelAuthlessAccountPrefix)
}

func syntheticAuthlessAccount(provider string) (appdb.ProviderAccount, bool) {
	if !auth.IsAuthlessProvider(provider) {
		return appdb.ProviderAccount{}, false
	}
	return appdb.ProviderAccount{ID: provider, Provider: provider, IsActive: true, Status: "active"}, true
}

func syntheticProviderModelAuthlessAccount(provider string) appdb.ProviderAccount {
	return appdb.ProviderAccount{ID: providerModelAuthlessAccountPrefix + provider, Provider: provider, IsActive: true, Status: "active"}
}

func syntheticProviderModelAuthlessAccountFromID(id, model string, registry interface{ IsAuthlessProviderModel(string, string) bool }) (appdb.ProviderAccount, bool) {
	provider := strings.TrimPrefix(id, providerModelAuthlessAccountPrefix)
	if provider == id || provider == "" || !registry.IsAuthlessProviderModel(model, provider) {
		return appdb.ProviderAccount{}, false
	}
	return syntheticProviderModelAuthlessAccount(provider), true
}

func stringSliceContains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func (s *Service) getEligibleAccounts(ctx context.Context, userID, model string, provider *string, exclude, excludeProviders []string, accountAccess auth.AccountAccess) ([]appdb.ProviderAccount, error) {
	targetProviders := []string{}
	if provider != nil {
		targetProviders = []string{*provider}
	} else {
		targetProviders = s.registry.ProvidersForModel(model)
	}
	if len(targetProviders) == 0 {
		return nil, nil
	}

	rows := []appdb.ProviderAccount{}
	for _, targetProvider := range targetProviders {
		account, ok := syntheticAuthlessAccount(targetProvider)
		if !ok && s.registry.IsAuthlessProviderModel(model, targetProvider) {
			account = syntheticProviderModelAuthlessAccount(targetProvider)
			ok = true
		}
		if !ok {
			continue
		}
		if len(exclude) > 0 && stringSliceContains(exclude, account.ID) {
			continue
		}
		if len(excludeProviders) > 0 && stringSliceContains(excludeProviders, account.Provider) {
			continue
		}
		if err := accountAllowed(account.ID, accountAccess); err != nil {
			continue
		}
		rows = append(rows, account)
	}

	now := time.Now()
	accountMode := normalizeAccessMode(accountAccess.Mode)
	accounts := normalizeAccountIDs(accountAccess.Accounts)
	dbRows, err := s.db.ListEligibleAccounts(ctx, appdb.ListEligibleAccountsParams{
		UserID:           userID,
		Providers:        appdb.NonNilStrings(targetProviders),
		Now:              &now,
		ExcludeIds:       appdb.NonNilStrings(exclude),
		ExcludeProviders: appdb.NonNilStrings(excludeProviders),
		UseWhitelist:     accountMode == "whitelist" && len(accounts) > 0,
		AccountIds:       appdb.NonNilStrings(accounts),
		UseBlacklist:     accountMode == "blacklist" && len(accounts) > 0,
	})
	if err != nil {
		return nil, err
	}
	for _, row := range dbRows {
		rows = append(rows, appdb.ProviderAccountFromEligible(row))
	}
	if len(rows) == 0 {
		return rows, nil
	}

	lookupKeys := s.registry.LookupKeys(model)
	ids := make([]string, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.ID)
	}
	disabled, err := s.db.ListDisabledAccountIDs(ctx, appdb.ListDisabledAccountIDsParams{
		AccountIds: appdb.NonNilStrings(ids),
		Models:     appdb.NonNilStrings(lookupKeys),
	})
	if err != nil {
		return nil, err
	}
	disabledSet := map[string]struct{}{}
	for _, providerAccountID := range disabled {
		disabledSet[providerAccountID] = struct{}{}
	}

	enabled := make([]appdb.ProviderAccount, 0, len(rows))
	for _, row := range rows {
		if isSyntheticProviderAccountID(row.ID) {
			enabled = append(enabled, row)
			continue
		}
		if _, disabled := disabledSet[row.ID]; !disabled && s.canAccountUseModel(row, model) {
			enabled = append(enabled, row)
		}
	}
	if provider == nil {
		sortAccountsByProviderPriority(enabled, targetProviders)
	}
	return enabled, nil
}

func (s *Service) getNextAvailableAccount(ctx context.Context, userID, model string, provider *string, exclude, excludeProviders []string, accountAccess auth.AccountAccess, sessionID string) (*appdb.ProviderAccount, bool, error) {
	eligible, err := s.getEligibleAccounts(ctx, userID, model, provider, exclude, excludeProviders, accountAccess)
	if err != nil {
		return nil, false, err
	}
	if len(eligible) == 0 {
		return nil, false, nil
	}
	prioritized := prioritizeAccounts(eligible, provider == nil, s.registry.ProvidersForModel(model))
	if stickyID := s.affinity.Lookup(ctx, userID, sessionID); stickyID != "" && !isSyntheticProviderAccountID(stickyID) {
		prioritized = sessionaffinity.Prefer(prioritized, func(a appdb.ProviderAccount) bool { return a.ID == stickyID })
	}
	selected, has, err := s.pickHealthyAccount(ctx, prioritized, model)
	if err != nil {
		return nil, false, err
	}
	if !has {
		return nil, false, nil
	}
	if selected != nil {
		s.rememberAffinityAccount(ctx, userID, sessionID, *selected)
	}
	return selected, has, nil
}

func (s *Service) rememberAffinityAccount(ctx context.Context, userID, sessionID string, account appdb.ProviderAccount) {
	if s == nil || s.affinity == nil || sessionID == "" || isSyntheticProviderAccountID(account.ID) {
		return
	}
	if !s.affinity.Enabled(account.Provider) {
		return
	}
	s.affinity.Store(ctx, userID, sessionID, account.ID)
}

func (s *Service) getNextSharedAccount(ctx context.Context, userID, model string, provider *string, exclude, excludeProviders []string) (*appdb.ProviderAccount, bool, error) {
	targetProviders := []string{}
	if provider != nil {
		targetProviders = []string{*provider}
	} else {
		targetProviders = s.registry.ProvidersForModel(model)
	}
	if len(targetProviders) == 0 {
		return nil, false, nil
	}

	now := time.Now()
	sharedRows, err := s.db.ListSharedEligibleAccounts(ctx, appdb.ListSharedEligibleAccountsParams{
		UserID:           userID,
		Providers:        appdb.NonNilStrings(targetProviders),
		Now:              &now,
		ExcludeIds:       appdb.NonNilStrings(exclude),
		ExcludeProviders: appdb.NonNilStrings(excludeProviders),
	})
	if err != nil {
		return nil, false, err
	}
	rows := make([]appdb.ProviderAccount, 0, len(sharedRows))
	for _, row := range sharedRows {
		rows = append(rows, appdb.ProviderAccountFromSharedEligible(row))
	}
	if len(rows) == 0 {
		return nil, false, nil
	}

	lookupKeys := s.registry.LookupKeys(model)
	ids := make([]string, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.ID)
	}

	disabled, err := s.db.ListDisabledAccountIDs(ctx, appdb.ListDisabledAccountIDsParams{
		AccountIds: appdb.NonNilStrings(ids),
		Models:     appdb.NonNilStrings(lookupKeys),
	})
	if err != nil {
		return nil, true, err
	}
	disabledSet := map[string]struct{}{}
	for _, providerAccountID := range disabled {
		disabledSet[providerAccountID] = struct{}{}
	}

	enabled := make([]appdb.ProviderAccount, 0, len(rows))
	for _, row := range rows {
		if _, disabled := disabledSet[row.ID]; !disabled && s.canAccountUseModel(row, model) {
			enabled = append(enabled, row)
		}
	}
	if len(enabled) == 0 {
		return nil, true, nil
	}
	prioritized := prioritizeAccounts(enabled, provider == nil, targetProviders)
	return s.pickHealthyAccount(ctx, prioritized, model)
}

func (s *Service) pickHealthyAccount(ctx context.Context, prioritized []appdb.ProviderAccount, model string) (*appdb.ProviderAccount, bool, error) {
	now := time.Now()
	ready := make([]appdb.ProviderAccount, 0, len(prioritized))
	for i := range prioritized {
		account := prioritized[i]
		if isSyntheticProviderAccountID(account.ID) {
			ready = append(ready, account)
			continue
		}
		coolingDown, err := s.refreshAccountHealthFromModels(ctx, account.ID, now)
		if err != nil {
			return nil, true, err
		}
		if coolingDown {
			continue
		}
		ready = append(ready, account)
	}
	if len(ready) == 0 {
		return nil, true, nil
	}

	ids := make([]string, 0, len(ready))
	for _, account := range ready {
		ids = append(ids, account.ID)
	}
	health, err := s.getHealthByAccount(ctx, ids, s.registry.LookupKeys(model))
	if err != nil {
		return nil, true, err
	}

	var selected *appdb.ProviderAccount
	for i := range ready {
		account := &ready[i]
		row, ok := health[account.ID]
		if ok {
			// A quota lock means this model is out of credits for this account.
			// Skip it entirely so rotation reaches a provider that can serve the
			// request, while sibling models on the same account stay usable.
			if row.QuotaLockedUntil != nil && row.QuotaLockedUntil.After(now) {
				continue
			}
			if row.Status == "degraded" {
				if selected == nil {
					selected = account
				}
				continue
			}
		}
		selected = account
		break
	}
	if selected == nil {
		return nil, true, nil
	}
	go s.bumpAccountRequestCount(context.Background(), selected.ID, now)
	return selected, true, nil
}

func (s *Service) bumpAccountRequestCount(ctx context.Context, accountID string, usedAt time.Time) {
	if isSyntheticProviderAccountID(accountID) {
		return
	}
	_ = s.db.BumpAccountRequestCount(ctx, appdb.BumpAccountRequestCountParams{LastUsedAt: &usedAt, ID: accountID})
}

func (s *Service) getHealthByAccount(ctx context.Context, accountIDs, modelKeys []string) (map[string]appdb.ProviderAccountModelHealth, error) {
	result := map[string]appdb.ProviderAccountModelHealth{}
	if len(accountIDs) == 0 || len(modelKeys) == 0 {
		return result, nil
	}
	rows, err := s.db.ListModelHealthByAccounts(ctx, appdb.ListModelHealthByAccountsParams{
		AccountIds: appdb.NonNilStrings(accountIDs),
		Models:     appdb.NonNilStrings(modelKeys),
	})
	if err != nil {
		return result, err
	}
	for _, row := range rows {
		result[row.ProviderAccountID] = row
	}
	return result, nil
}

func latestHealthRequestAt(row appdb.ProviderAccountModelHealth) *time.Time {
	latest := row.UnhealthyCountUpdatedAt
	if row.LastErrorAt != nil && (latest == nil || row.LastErrorAt.After(*latest)) {
		latest = row.LastErrorAt
	}
	if row.LastSuccessAt != nil && (latest == nil || row.LastSuccessAt.After(*latest)) {
		latest = row.LastSuccessAt
	}
	if latest == nil && !row.UpdatedAt.IsZero() {
		latest = &row.UpdatedAt
	}
	if latest == nil && !row.CreatedAt.IsZero() {
		latest = &row.CreatedAt
	}
	return latest
}

func effectiveUnhealthyCount(row appdb.ProviderAccountModelHealth, now time.Time) int {
	count := row.ConsecutiveErrors
	if count <= 0 {
		return 0
	}
	lastRequestAt := latestHealthRequestAt(row)
	if lastRequestAt == nil || lastRequestAt.After(now) {
		return count
	}
	decay := int(now.Sub(*lastRequestAt) / unhealthyIdleDecayInterval)
	if decay <= 0 {
		return count
	}
	if decay >= count {
		return 0
	}
	return count - decay
}

func modelHealthStatus(unhealthyCount int) string {
	if unhealthyCount >= modelDegradedThreshold {
		return "degraded"
	}
	return "active"
}

func cooldownRecoveryCount(unhealthyCount int) int {
	if unhealthyCount <= 0 {
		return 0
	}
	reduction := int(math.Round(float64(unhealthyCount) * cooldownRecoveryRatio))
	if reduction < 0 {
		reduction = 0
	}
	if reduction > unhealthyCount {
		return 0
	}
	return unhealthyCount - reduction
}

func isImmediatelyRecoverableStatusCode(code int) bool {
	return code == http.StatusRequestTimeout || code == http.StatusTooManyRequests || code >= http.StatusInternalServerError
}

func successRecoveryCount(row appdb.ProviderAccountModelHealth, now time.Time) int {
	count := effectiveUnhealthyCount(row, now)
	if row.LastErrorCode != nil && !isImmediatelyRecoverableStatusCode(*row.LastErrorCode) {
		return count
	}
	if count > 0 {
		count--
	}
	return count
}

func (s *Service) normalizeModelHealthRows(ctx context.Context, rows []appdb.ProviderAccountModelHealth, now time.Time, applyCooldownRecovery bool) (int, error) {
	total := 0
	for _, row := range rows {
		count := effectiveUnhealthyCount(row, now)
		if applyCooldownRecovery {
			count = cooldownRecoveryCount(count)
		}
		status := modelHealthStatus(count)
		statusChanged := status != row.Status
		total += count

		if count == row.ConsecutiveErrors && !statusChanged && !applyCooldownRecovery {
			continue
		}
		if row.Status == "failed" || statusChanged {
			err := s.db.UpdateModelHealthStatus(ctx, appdb.UpdateModelHealthStatusParams{
				ConsecutiveErrors:       count,
				UnhealthyCountUpdatedAt: &now,
				Status:                  status,
				StatusChangedAt:         &now,
				ID:                      row.ID,
			})
			if err != nil {
				return total, err
			}
			continue
		}
		if err := s.db.UpdateModelHealthCounters(ctx, appdb.UpdateModelHealthCountersParams{
			ConsecutiveErrors:       count,
			UnhealthyCountUpdatedAt: &now,
			ID:                      row.ID,
		}); err != nil {
			return total, err
		}
	}
	return total, nil
}

func (s *Service) refreshAccountHealthFromModels(ctx context.Context, accountID string, now time.Time) (bool, error) {
	if isSyntheticProviderAccountID(accountID) {
		return false, nil
	}

	account, err := s.db.GetAccountHealthState(ctx, accountID)
	if err != nil {
		return false, err
	}

	rows, err := s.db.ListModelHealthByAccount(ctx, accountID)
	if err != nil {
		return false, err
	}

	applyCooldownRecovery := account.Status == "failed" && account.DisabledUntil != nil && !account.DisabledUntil.After(now)
	total, err := s.normalizeModelHealthRows(ctx, rows, now, applyCooldownRecovery)
	if err != nil {
		return false, err
	}

	if account.DisabledUntil != nil && account.DisabledUntil.After(now) {
		if account.ConsecutiveErrors != total {
			err := s.db.SetAccountHealthFailed(ctx, appdb.SetAccountHealthFailedParams{
				ConsecutiveErrors: total,
				Status:            "failed",
				StatusChangedAt:   &now,
				ID:                accountID,
			})
			return true, err
		}
		return true, nil
	}

	if total >= accountCooldownUnhealthyThreshold {
		cooldownUntil := failedCooldownUntil(now)
		err := s.db.SetAccountCooldown(ctx, appdb.SetAccountCooldownParams{
			Status:            "failed",
			StatusChangedAt:   &now,
			ConsecutiveErrors: total,
			DisabledUntil:     &cooldownUntil,
			ID:                accountID,
		})
		return true, err
	}

	if account.Status != "active" || account.DisabledUntil != nil && !account.DisabledUntil.After(now) || account.ConsecutiveErrors != total {
		err := s.db.SetAccountActive(ctx, appdb.SetAccountActiveParams{
			Status:            "active",
			StatusChangedAt:   &now,
			ConsecutiveErrors: total,
			ID:                accountID,
		})
		return false, err
	}

	return false, nil
}

func (s *Service) validateForcedAccount(ctx context.Context, userID string, validation auth.ModelValidationResult, forcedAccountID *string, accountAccess auth.AccountAccess, allowInactive bool) (*appdb.ProviderAccount, *routeError) {
	if forcedAccountID == nil {
		return nil, nil
	}
	id := strings.TrimSpace(*forcedAccountID)
	param := "model"
	if id == "" {
		return nil, &routeError{Status: http.StatusBadRequest, Message: "model account selector must include an account prefix", Type: "invalid_request_error", Param: &param, Code: strPtr("invalid_provider_account")}
	}
	if account, ok := syntheticAuthlessAccount(id); ok {
		if message, code, denied := accountAccessDenial(account.ID, accountAccess); denied {
			return nil, &routeError{Status: http.StatusForbidden, Message: message, Type: "invalid_request_error", Param: &param, Code: strPtr(code)}
		}
		if modelErr := s.validateSelectedAccountModel(account, validation, param); modelErr != nil {
			return nil, modelErr
		}
		return &account, nil
	}
	if account, ok := syntheticProviderModelAuthlessAccountFromID(id, validation.Model, s.registry); ok {
		if message, code, denied := accountAccessDenial(account.ID, accountAccess); denied {
			return nil, &routeError{Status: http.StatusForbidden, Message: message, Type: "invalid_request_error", Param: &param, Code: strPtr(code)}
		}
		if modelErr := s.validateSelectedAccountModel(account, validation, param); modelErr != nil {
			return nil, modelErr
		}
		return &account, nil
	}
	row, err := s.db.GetForcedAccount(ctx, appdb.GetForcedAccountParams{ID: id, UserID: userID})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, &routeError{Status: http.StatusBadRequest, Message: "Selected provider account was not found", Type: "invalid_request_error", Param: &param, Code: strPtr("provider_account_not_found")}
		}
		return nil, &routeError{Status: http.StatusInternalServerError, Message: "Internal server error", Type: "api_error"}
	}
	account := appdb.ProviderAccountFromForced(row)
	if coolingDown, err := s.refreshAccountHealthFromModels(ctx, account.ID, time.Now()); err != nil {
		return nil, &routeError{Status: http.StatusInternalServerError, Message: "Internal server error", Type: "api_error"}
	} else if coolingDown {
		return nil, &routeError{Status: http.StatusBadRequest, Message: "Selected provider account is temporarily disabled", Type: "invalid_request_error", Param: &param, Code: strPtr("provider_account_temporarily_disabled")}
	}
	if availabilityErr := validateForcedAccountAvailability(account, allowInactive, param); availabilityErr != nil {
		return nil, availabilityErr
	}
	if message, code, denied := accountAccessDenial(account.ID, accountAccess); denied {
		return nil, &routeError{Status: http.StatusForbidden, Message: message, Type: "invalid_request_error", Param: &param, Code: strPtr(code)}
	}
	if modelErr := s.validateSelectedAccountModel(account, validation, param); modelErr != nil {
		return nil, modelErr
	}
	return &account, nil
}

func (s *Service) validateSelectedAccountModel(account appdb.ProviderAccount, validation auth.ModelValidationResult, param string) *routeError {
	if !s.registry.IsSupportedByProvider(validation.Model, account.Provider) {
		return &routeError{Status: http.StatusBadRequest, Message: "Selected account provider \"" + account.Provider + "\" does not support model \"" + validation.Model + "\"", Type: "invalid_request_error", Param: &param, Code: strPtr("provider_account_model_mismatch")}
	}
	if validation.Provider != nil && account.Provider != *validation.Provider {
		return &routeError{Status: http.StatusBadRequest, Message: "Selected account provider \"" + account.Provider + "\" does not match model provider \"" + *validation.Provider + "\"", Type: "invalid_request_error", Param: &param, Code: strPtr("provider_account_provider_mismatch")}
	}
	if !s.canAccountUseModel(account, validation.Model) {
		return &routeError{Status: http.StatusBadRequest, Message: "Selected provider account tier does not allow model \"" + validation.Model + "\"", Type: "invalid_request_error", Param: &param, Code: strPtr("provider_account_tier_mismatch")}
	}
	return nil
}

func validateForcedAccountAvailability(account appdb.ProviderAccount, allowInactive bool, param string) *routeError {
	if allowInactive {
		return nil
	}
	if !account.IsActive {
		return &routeError{Status: http.StatusBadRequest, Message: "Selected provider account is inactive", Type: "invalid_request_error", Param: &param, Code: strPtr("provider_account_inactive")}
	}
	if account.DisabledUntil != nil && account.DisabledUntil.After(time.Now()) {
		return &routeError{Status: http.StatusBadRequest, Message: "Selected provider account is temporarily disabled", Type: "invalid_request_error", Param: &param, Code: strPtr("provider_account_temporarily_disabled")}
	}
	return nil
}

func (s *Service) markAccountSuccess(ctx context.Context, accountID, model string) {
	if isSyntheticProviderAccountID(accountID) {
		return
	}
	now := time.Now()
	_ = s.db.MarkAccountSuccess(ctx, appdb.MarkAccountSuccessParams{LastSuccessAt: &now, ID: accountID})
	resolved := s.registry.ResolveAlias(model)
	health, err := s.db.GetModelHealth(ctx, appdb.GetModelHealthParams{ProviderAccountID: accountID, Model: resolved})
	if err != nil {
		_, _ = s.refreshAccountHealthFromModels(ctx, accountID, now)
		return
	}
	nextErrors := successRecoveryCount(health, now)
	nextStatus := modelHealthStatus(nextErrors)
	if nextStatus != health.Status {
		_ = s.db.UpdateModelHealthSuccessWithStatus(ctx, appdb.UpdateModelHealthSuccessWithStatusParams{
			ConsecutiveErrors:       nextErrors,
			LastSuccessAt:           &now,
			UnhealthyCountUpdatedAt: &now,
			Status:                  nextStatus,
			StatusChangedAt:         &now,
			ID:                      health.ID,
		})
	} else {
		_ = s.db.UpdateModelHealthSuccess(ctx, appdb.UpdateModelHealthSuccessParams{
			ConsecutiveErrors:       nextErrors,
			LastSuccessAt:           &now,
			UnhealthyCountUpdatedAt: &now,
			ID:                      health.ID,
		})
	}
	_, _ = s.refreshAccountHealthFromModels(ctx, accountID, now)
}

func (s *Service) recordSuccessfulRequest(ctx context.Context, accountID, provider, model, userID, apiKeyID string, inputTokens, outputTokens, durationMS int, stream bool, requestStartMS, upstreamFirstResponseMS int64) {
	s.markAccountSuccess(ctx, accountID, model)
	// A working model must not stay skipped if it was locked earlier.
	s.clearAccountModelQuotaLock(ctx, accountID, model)
	if upstreamFirstResponseMS > requestStartMS {
		s.recordLatency(ctx, provider, model, stream, upstreamFirstResponseMS-requestStartMS)
	}
	s.logUsage(ctx, usageParams{UserID: userID, ProviderAccountID: accountID, ProxyAPIKeyID: apiKeyID, Model: model, InputTokens: inputTokens, OutputTokens: outputTokens, StatusCode: http.StatusOK, DurationMS: durationMS, Provider: provider})
}

func (s *Service) markAccountFailed(ctx context.Context, accountID, model string, statusCode int, message string) time.Time {
	now := time.Now()
	if isSyntheticProviderAccountID(accountID) {
		return now
	}
	if len(message) > maxStoredErrorLen {
		message = message[:maxStoredErrorLen]
	}
	_ = s.db.RecordRequestError(ctx, appdb.RecordRequestErrorParams{LastErrorAt: &now, LastErrorCode: &statusCode, ID: accountID})
	resolved := s.registry.ResolveAlias(model)
	health, err := s.db.GetModelHealth(ctx, appdb.GetModelHealthParams{ProviderAccountID: accountID, Model: resolved})
	if err == nil {
		nextErrors := effectiveUnhealthyCount(health, now) + 1
		nextStatus := modelHealthStatus(nextErrors)
		if nextStatus != health.Status {
			_ = s.db.UpdateModelHealthFailureWithStatus(ctx, appdb.UpdateModelHealthFailureWithStatusParams{
				ConsecutiveErrors:       nextErrors,
				LastErrorAt:             &now,
				LastErrorCode:           &statusCode,
				UnhealthyCountUpdatedAt: &now,
				Status:                  nextStatus,
				StatusChangedAt:         &now,
				ID:                      health.ID,
			})
		} else {
			_ = s.db.UpdateModelHealthFailure(ctx, appdb.UpdateModelHealthFailureParams{
				ConsecutiveErrors:       nextErrors,
				LastErrorAt:             &now,
				LastErrorCode:           &statusCode,
				UnhealthyCountUpdatedAt: &now,
				ID:                      health.ID,
			})
		}
	} else {
		nextErrors := 1
		nextStatus := modelHealthStatus(nextErrors)
		_ = s.db.InsertModelHealth(ctx, appdb.InsertModelHealthParams{
			ID:                      appdb.NewID(),
			ProviderAccountID:       accountID,
			Model:                   resolved,
			ConsecutiveErrors:       nextErrors,
			Status:                  nextStatus,
			LastErrorAt:             &now,
			LastErrorCode:           &statusCode,
			UnhealthyCountUpdatedAt: &now,
			CreatedAt:               now,
			UpdatedAt:               now,
		})
	}
	_, _ = s.refreshAccountHealthFromModels(ctx, accountID, now)

	if ownerUserID, err := s.db.GetAccountOwnerUserID(ctx, accountID); err == nil && ownerUserID != "" {
		modelValue := resolved
		_ = s.upsertErrorHistory(ctx, accountID, ownerUserID, &modelValue, statusCode, message, now)
	}
	return now
}

func failedCooldownUntil(failedAt time.Time) time.Time {
	return failedAt.Add(failedCooldown)
}

// lockAccountModelQuota records a per-model quota lock. The account stays
// active because a provider can reject one model for billing while still
// serving others: Qoder returns code 112 for its frontier models but keeps
// serving `lite` on the same over-quota account. Deactivating the account would
// take those working models down with it.
func (s *Service) lockAccountModelQuota(ctx context.Context, accountID, model string, until time.Time, reason string) {
	if isSyntheticProviderAccountID(accountID) || model == "" || until.IsZero() {
		return
	}
	now := time.Now()
	resolved := s.registry.ResolveAlias(model)
	_ = s.db.LockModelQuota(ctx, appdb.LockModelQuotaParams{
		ID:                appdb.NewID(),
		ProviderAccountID: accountID,
		Model:             resolved,
		QuotaLockedUntil:  &until,
		QuotaLockReason:   &reason,
		CreatedAt:         now,
		UpdatedAt:         now,
	})
}

// clearAccountModelQuotaLock removes a lock after the model works again, so a
// recovered model is not skipped until the original lock expires.
func (s *Service) clearAccountModelQuotaLock(ctx context.Context, accountID, model string) {
	if isSyntheticProviderAccountID(accountID) || model == "" {
		return
	}
	resolved := s.registry.ResolveAlias(model)
	_ = s.db.ClearModelQuotaLock(ctx, appdb.ClearModelQuotaLockParams{ProviderAccountID: accountID, Model: resolved})
}

func (s *Service) markAccountUsageLimited(ctx context.Context, accountID, model string, disabledUntil, failedAt time.Time) {
	if isSyntheticProviderAccountID(accountID) {
		return
	}
	resolved := s.registry.ResolveAlias(model)
	_ = s.db.MarkUsageLimitedHealth(ctx, appdb.MarkUsageLimitedHealthParams{
		Status:            "failed",
		StatusChangedAt:   &failedAt,
		ConsecutiveErrors: accountCooldownUnhealthyThreshold,
		ProviderAccountID: accountID,
		Model:             resolved,
	})
	_, _ = s.refreshAccountHealthFromModels(ctx, accountID, failedAt)
	_ = s.db.SetAccountUsageLimited(ctx, appdb.SetAccountUsageLimitedParams{
		DisabledUntil:   &disabledUntil,
		Status:          "failed",
		StatusChangedAt: &failedAt,
		ID:              accountID,
	})
}

func (s *Service) markAccountsRecoveredByRotation(ctx context.Context, failures []accountRotationFailure) {
	latest := map[string]time.Time{}
	for _, failure := range failures {
		if existing, ok := latest[failure.AccountID]; !ok || failure.FailedAt.After(existing) {
			latest[failure.AccountID] = failure.FailedAt
		}
	}
	if len(latest) == 0 {
		return
	}
	recoveredAt := time.Now()
	for accountID, failedAt := range latest {
		if isSyntheticProviderAccountID(accountID) {
			continue
		}
		_ = s.db.MarkAccountRecoveredByRotation(ctx, appdb.MarkAccountRecoveredByRotationParams{
			LastRecoveredByRotationAt: &recoveredAt,
			ID:                        accountID,
			LastErrorAt:               &failedAt,
		})
	}
}

func sortAccountsByProviderPriority(accounts []appdb.ProviderAccount, priority []string) {
	order := map[string]int{}
	for i, provider := range priority {
		order[provider] = i
	}
	sort.SliceStable(accounts, func(i, j int) bool {
		ai, aok := order[accounts[i].Provider]
		if !aok {
			ai = 1 << 30
		}
		aj, aok := order[accounts[j].Provider]
		if !aok {
			aj = 1 << 30
		}
		if ai != aj {
			return ai < aj
		}
		if accounts[i].Status != accounts[j].Status {
			return accounts[i].Status < accounts[j].Status
		}
		return nullableTimeBefore(accounts[i].LastUsedAt, accounts[j].LastUsedAt)
	})
}

func prioritizeAccounts(accounts []appdb.ProviderAccount, groupByProvider bool, priority []string) []appdb.ProviderAccount {
	if !groupByProvider {
		return paidFirst(accounts)
	}
	byProvider := map[string][]appdb.ProviderAccount{}
	for _, account := range accounts {
		byProvider[account.Provider] = append(byProvider[account.Provider], account)
	}
	result := []appdb.ProviderAccount{}
	for _, provider := range priority {
		result = append(result, paidFirst(byProvider[provider])...)
	}
	return result
}

func paidFirst(accounts []appdb.ProviderAccount) []appdb.ProviderAccount {
	paid := []appdb.ProviderAccount{}
	free := []appdb.ProviderAccount{}
	for _, account := range accounts {
		if isSyntheticProviderAccountID(account.ID) {
			free = append(free, account)
		} else if isPaidAccountTier(account.Provider, account.Tier) {
			paid = append(paid, account)
		} else {
			free = append(free, account)
		}
	}
	return append(paid, free...)
}

func isPaidAccountTier(provider string, tier *string) bool {
	if tier == nil {
		return false
	}
	value := strings.ToLower(strings.TrimSpace(*tier))
	switch provider {
	case "antigravity":
		return value == "paid" || value == "standard-tier"
	case "kiro":
		return value == "pro" || value == "pro+" || value == "pro-plus" || value == "power"
	}
	switch value {
	case "paid", "standard-tier", "plus", "pro", "pro-plus", "pro+", "prolite", "power", "team", "go", "self_serve_business_usage_based", "business", "enterprise_cbp_usage_based", "enterprise", "edu", "education", "hc":
		return true
	default:
		return false
	}
}

func nullableTimeBefore(a, b *time.Time) bool {
	if a == nil && b == nil {
		return false
	}
	if a == nil {
		return true
	}
	if b == nil {
		return false
	}
	return a.Before(*b)
}

func accountAllowed(accountID string, access auth.AccountAccess) error {
	message, _, denied := accountAccessDenial(accountID, access)
	if denied {
		return errors.New(message)
	}
	return nil
}

func accountAccessDenial(accountID string, access auth.AccountAccess) (string, string, bool) {
	mode := normalizeAccessMode(access.Mode)
	set := map[string]struct{}{}
	for _, id := range normalizeAccountIDs(access.Accounts) {
		set[id] = struct{}{}
	}
	if mode == "whitelist" {
		if _, ok := set[accountID]; !ok {
			return "Selected provider account is not allowed for this API key.", "provider_account_not_whitelisted", true
		}
	}
	if mode == "blacklist" {
		if _, ok := set[accountID]; ok {
			return "Selected provider account is blocked for this API key.", "provider_account_blacklisted", true
		}
	}
	return "", "", false
}

func normalizeAccessMode(mode string) string {
	if mode == "whitelist" || mode == "blacklist" {
		return mode
	}
	return "all"
}

func normalizeAccountIDs(values []string) []string {
	seen := map[string]struct{}{}
	result := []string{}
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			continue
		}
		if _, ok := seen[trimmed]; ok {
			continue
		}
		seen[trimmed] = struct{}{}
		result = append(result, trimmed)
	}
	sort.Strings(result)
	return result
}

func strPtr(value string) *string { return &value }
