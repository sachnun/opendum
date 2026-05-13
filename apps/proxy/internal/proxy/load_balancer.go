package proxy

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/uptrace/bun"

	"github.com/opendum/opendum/apps/proxy/internal/auth"
	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
)

const (
	failedCooldown                     = 10 * time.Minute
	degradedThreshold                  = 3
	failedThreshold                    = 7
	maxStoredErrorLen                  = 10000
	maxErrorHistoryRows                = 200
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

func (s *Service) getEligibleAccounts(ctx context.Context, userID, model string, provider *string, exclude []string, accountAccess auth.AccountAccess) ([]appdb.ProviderAccount, error) {
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
		if err := accountAllowed(account.ID, accountAccess); err != nil {
			continue
		}
		rows = append(rows, account)
	}

	query := s.db.NewSelect().Model((*appdb.ProviderAccount)(nil)).
		Column("id", "userId", "provider", "tier", "status", "lastUsedAt", "createdAt", "accountId", "disabledUntil").
		Where("\"userId\" = ?", userID).
		Where("provider IN (?)", bun.In(targetProviders)).
		Where("\"isActive\" = TRUE").
		Where("(\"disabledUntil\" IS NULL OR \"disabledUntil\" <= ?)", time.Now())
	if len(exclude) > 0 {
		query.Where("id NOT IN (?)", bun.In(exclude))
	}
	accountMode := normalizeAccessMode(accountAccess.Mode)
	accounts := normalizeAccountIDs(accountAccess.Accounts)
	if accountMode == "whitelist" && len(accounts) > 0 {
		query.Where("id IN (?)", bun.In(accounts))
	}
	if accountMode == "blacklist" && len(accounts) > 0 {
		query.Where("id NOT IN (?)", bun.In(accounts))
	}

	var dbRows []appdb.ProviderAccount
	if err := query.OrderExpr("status ASC").OrderExpr("\"lastUsedAt\" ASC NULLS FIRST").OrderExpr("\"createdAt\" ASC").Scan(ctx, &dbRows); err != nil {
		return nil, err
	}
	rows = append(rows, dbRows...)
	if len(rows) == 0 {
		return rows, nil
	}

	lookupKeys := s.registry.LookupKeys(model)
	ids := make([]string, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.ID)
	}
	var disabled []appdb.ProviderAccountDisabledModel
	if err := s.db.NewSelect().Model(&disabled).Column("providerAccountId").Where("\"providerAccountId\" IN (?)", bun.In(ids)).Where("model IN (?)", bun.In(lookupKeys)).Scan(ctx); err != nil {
		return nil, err
	}
	disabledSet := map[string]struct{}{}
	for _, row := range disabled {
		disabledSet[row.ProviderAccountID] = struct{}{}
	}

	enabled := make([]appdb.ProviderAccount, 0, len(rows))
	for _, row := range rows {
		if isSyntheticProviderAccountID(row.ID) {
			enabled = append(enabled, row)
			continue
		}
		if _, disabled := disabledSet[row.ID]; !disabled {
			enabled = append(enabled, row)
		}
	}
	if provider == nil {
		sortAccountsByProviderPriority(enabled, targetProviders)
	}
	return enabled, nil
}

func (s *Service) getNextAvailableAccount(ctx context.Context, userID, model string, provider *string, exclude []string, accountAccess auth.AccountAccess) (*appdb.ProviderAccount, bool, error) {
	eligible, err := s.getEligibleAccounts(ctx, userID, model, provider, exclude, accountAccess)
	if err != nil {
		return nil, false, err
	}
	if len(eligible) == 0 {
		return nil, false, nil
	}
	prioritized := prioritizeAccounts(eligible, provider == nil, s.registry.ProvidersForModel(model))
	ids := make([]string, 0, len(prioritized))
	for _, account := range prioritized {
		ids = append(ids, account.ID)
	}
	health, err := s.getHealthByAccount(ctx, ids, s.registry.LookupKeys(model))
	if err != nil {
		return nil, true, err
	}

	now := time.Now()
	var selected *appdb.ProviderAccount
	for i := range prioritized {
		account := &prioritized[i]
		row, ok := health[account.ID]
		if ok {
			if row.Status == "failed" {
				if row.StatusChangedAt != nil && now.Sub(*row.StatusChangedAt) < failedCooldown {
					continue
				}
				reason := "cooldown expired, probing"
				_, _ = s.db.NewUpdate().Model((*appdb.ProviderAccountModelHealth)(nil)).Set("status = ?", "half_open").Set("\"statusReason\" = ?", reason).Set("\"statusChangedAt\" = ?", now).Where("id = ?", row.ID).Exec(ctx)
			}
			if row.Status == "half_open" || row.Status == "degraded" {
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
	_, _ = s.db.NewUpdate().Model((*appdb.ProviderAccount)(nil)).Set("\"lastUsedAt\" = ?", usedAt).Set("\"requestCount\" = \"requestCount\" + 1").Where("id = ?", accountID).Exec(ctx)
}

func (s *Service) getHealthByAccount(ctx context.Context, accountIDs, modelKeys []string) (map[string]appdb.ProviderAccountModelHealth, error) {
	result := map[string]appdb.ProviderAccountModelHealth{}
	if len(accountIDs) == 0 || len(modelKeys) == 0 {
		return result, nil
	}
	var rows []appdb.ProviderAccountModelHealth
	if err := s.db.NewSelect().Model(&rows).Where("\"providerAccountId\" IN (?)", bun.In(accountIDs)).Where("model IN (?)", bun.In(modelKeys)).Scan(ctx); err != nil {
		return result, err
	}
	for _, row := range rows {
		result[row.ProviderAccountID] = row
	}
	return result, nil
}

func (s *Service) validateForcedAccount(ctx context.Context, userID string, validation auth.ModelValidationResult, providerAccountID *string, accountAccess auth.AccountAccess, allowInactive bool, cfg endpointAdapter) (*appdb.ProviderAccount, *routeError) {
	if providerAccountID == nil {
		return nil, nil
	}
	id := strings.TrimSpace(*providerAccountID)
	param := "provider_account_id"
	if id == "" {
		return nil, &routeError{Status: http.StatusBadRequest, Message: "provider_account_id must be a non-empty string", Type: "invalid_request_error", Param: &param, Code: strPtr("invalid_provider_account")}
	}
	if account, ok := syntheticAuthlessAccount(id); ok {
		if message, code, denied := accountAccessDenial(account.ID, accountAccess); denied {
			return nil, &routeError{Status: http.StatusForbidden, Message: message, Type: "invalid_request_error", Param: &param, Code: strPtr(code)}
		}
		if !s.registry.IsSupportedByProvider(validation.Model, account.Provider) {
			return nil, &routeError{Status: http.StatusBadRequest, Message: "Selected account provider \"" + account.Provider + "\" does not support model \"" + validation.Model + "\"", Type: "invalid_request_error", Param: &param, Code: strPtr("provider_account_model_mismatch")}
		}
		if validation.Provider != nil && account.Provider != *validation.Provider {
			return nil, &routeError{Status: http.StatusBadRequest, Message: "Selected account provider \"" + account.Provider + "\" does not match model provider \"" + *validation.Provider + "\"", Type: "invalid_request_error", Param: &param, Code: strPtr("provider_account_provider_mismatch")}
		}
		return &account, nil
	}
	if account, ok := syntheticProviderModelAuthlessAccountFromID(id, validation.Model, s.registry); ok {
		if message, code, denied := accountAccessDenial(account.ID, accountAccess); denied {
			return nil, &routeError{Status: http.StatusForbidden, Message: message, Type: "invalid_request_error", Param: &param, Code: strPtr(code)}
		}
		if !s.registry.IsSupportedByProvider(validation.Model, account.Provider) {
			return nil, &routeError{Status: http.StatusBadRequest, Message: "Selected account provider \"" + account.Provider + "\" does not support model \"" + validation.Model + "\"", Type: "invalid_request_error", Param: &param, Code: strPtr("provider_account_model_mismatch")}
		}
		if validation.Provider != nil && account.Provider != *validation.Provider {
			return nil, &routeError{Status: http.StatusBadRequest, Message: "Selected account provider \"" + account.Provider + "\" does not match model provider \"" + *validation.Provider + "\"", Type: "invalid_request_error", Param: &param, Code: strPtr("provider_account_provider_mismatch")}
		}
		return &account, nil
	}
	var account appdb.ProviderAccount
	err := s.db.NewSelect().Model(&account).Column("id", "userId", "provider", "tier", "status", "lastUsedAt", "createdAt", "accountId", "isActive", "disabledUntil").Where("id = ?", id).Where("\"userId\" = ?", userID).Limit(1).Scan(ctx)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, &routeError{Status: http.StatusBadRequest, Message: "Selected provider account was not found", Type: "invalid_request_error", Param: &param, Code: strPtr("provider_account_not_found")}
		}
		return nil, &routeError{Status: http.StatusInternalServerError, Message: "Internal server error", Type: "api_error"}
	}
	if availabilityErr := validateForcedAccountAvailability(account, allowInactive, param); availabilityErr != nil {
		return nil, availabilityErr
	}
	if message, code, denied := accountAccessDenial(account.ID, accountAccess); denied {
		return nil, &routeError{Status: http.StatusForbidden, Message: message, Type: "invalid_request_error", Param: &param, Code: strPtr(code)}
	}
	if !s.registry.IsSupportedByProvider(validation.Model, account.Provider) {
		return nil, &routeError{Status: http.StatusBadRequest, Message: "Selected account provider \"" + account.Provider + "\" does not support model \"" + validation.Model + "\"", Type: "invalid_request_error", Param: &param, Code: strPtr("provider_account_model_mismatch")}
	}
	if validation.Provider != nil && account.Provider != *validation.Provider {
		return nil, &routeError{Status: http.StatusBadRequest, Message: "Selected account provider \"" + account.Provider + "\" does not match model provider \"" + *validation.Provider + "\"", Type: "invalid_request_error", Param: &param, Code: strPtr("provider_account_provider_mismatch")}
	}
	return &account, nil
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
	_, _ = s.db.NewUpdate().Model((*appdb.ProviderAccount)(nil)).Set("\"successCount\" = \"successCount\" + 1").Set("\"lastSuccessAt\" = ?", now).Where("id = ?", accountID).Exec(ctx)
	resolved := s.registry.ResolveAlias(model)
	var health appdb.ProviderAccountModelHealth
	err := s.db.NewSelect().Model(&health).Where("\"providerAccountId\" = ?", accountID).Where("model = ?", resolved).Limit(1).Scan(ctx)
	if err != nil {
		return
	}
	query := s.db.NewUpdate().Model((*appdb.ProviderAccountModelHealth)(nil)).Set("\"consecutiveErrors\" = 0").Set("\"lastSuccessAt\" = ?", now).Where("id = ?", health.ID)
	if health.Status == "degraded" || health.Status == "failed" || health.Status == "half_open" {
		query.Set("status = ?", "active").Set("\"statusReason\" = NULL").Set("\"statusChangedAt\" = ?", now)
	}
	_, _ = query.Exec(ctx)
}

func (s *Service) recordSuccessfulRequest(ctx context.Context, accountID, provider, model, userID, apiKeyID string, inputTokens, outputTokens, durationMS int, stream bool, requestStartMS int64) {
	s.markAccountSuccess(ctx, accountID, model)
	s.recordLatency(ctx, provider, model, stream, time.Now().UnixMilli()-requestStartMS)
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
	_, _ = s.db.NewUpdate().Model((*appdb.ProviderAccount)(nil)).Set("\"errorCount\" = \"errorCount\" + 1").Set("\"lastErrorAt\" = ?", now).Set("\"lastErrorMessage\" = ?", message).Set("\"lastErrorCode\" = ?", statusCode).Where("id = ?", accountID).Exec(ctx)
	resolved := s.registry.ResolveAlias(model)
	healthID := appdb.NewID()
	_, _ = s.db.NewInsert().Model(&appdb.ProviderAccountModelHealth{ID: healthID, ProviderAccountID: accountID, Model: resolved, ConsecutiveErrors: 1, LastErrorAt: &now, LastErrorCode: &statusCode, LastErrorMessage: &message, CreatedAt: now, UpdatedAt: now}).
		On("CONFLICT (\"providerAccountId\", model) DO UPDATE").
		Set("\"consecutiveErrors\" = provider_account_model_health.\"consecutiveErrors\" + 1").
		Set("\"lastErrorAt\" = ?", now).
		Set("\"lastErrorCode\" = ?", statusCode).
		Set("\"lastErrorMessage\" = ?", message).
		Exec(ctx)

	var health appdb.ProviderAccountModelHealth
	if err := s.db.NewSelect().Model(&health).Where("\"providerAccountId\" = ?", accountID).Where("model = ?", resolved).Limit(1).Scan(ctx); err == nil {
		newStatus := ""
		reason := ""
		if health.Status == "half_open" {
			newStatus = "failed"
			reason = "probe failed during half-open (" + resolved + ")"
		} else if health.ConsecutiveErrors >= failedThreshold && health.Status != "failed" {
			newStatus = "failed"
			reason = "consecutive errors on " + resolved
		} else if health.ConsecutiveErrors >= degradedThreshold && health.Status == "active" {
			newStatus = "degraded"
			reason = "consecutive errors on " + resolved
		}
		if newStatus != "" {
			_, _ = s.db.NewUpdate().Model((*appdb.ProviderAccountModelHealth)(nil)).Set("status = ?", newStatus).Set("\"statusReason\" = ?", reason).Set("\"statusChangedAt\" = ?", now).Where("id = ?", health.ID).Exec(ctx)
			if newStatus == "failed" {
				s.disableAccountForFailedCooldown(ctx, accountID, now)
			}
		}
	}

	var account appdb.ProviderAccount
	if err := s.db.NewSelect().Model(&account).Column("userId").Where("id = ?", accountID).Limit(1).Scan(ctx); err == nil {
		modelValue := resolved
		_ = s.insertErrorHistory(ctx, accountID, account.UserID, &modelValue, statusCode, message, now)
	}
	return now
}

func failedCooldownUntil(failedAt time.Time) time.Time {
	return failedAt.Add(failedCooldown)
}

func (s *Service) disableAccountForFailedCooldown(ctx context.Context, accountID string, failedAt time.Time) {
	if isSyntheticProviderAccountID(accountID) {
		return
	}
	_, _ = s.db.NewUpdate().Model((*appdb.ProviderAccount)(nil)).
		Set("\"disabledUntil\" = ?", failedCooldownUntil(failedAt)).
		Where("id = ?", accountID).
		Exec(ctx)
}

func (s *Service) markAccountUsageLimited(ctx context.Context, accountID, model string, disabledUntil, failedAt time.Time) {
	if isSyntheticProviderAccountID(accountID) {
		return
	}
	reason := "usage limit reached until " + disabledUntil.UTC().Format(time.RFC3339)
	_, _ = s.db.NewUpdate().Model((*appdb.ProviderAccount)(nil)).
		Set("\"disabledUntil\" = ?", disabledUntil).
		Where("id = ?", accountID).
		Exec(ctx)

	resolved := s.registry.ResolveAlias(model)
	_, _ = s.db.NewUpdate().Model((*appdb.ProviderAccountModelHealth)(nil)).
		Set("status = ?", "failed").
		Set("\"statusReason\" = ?", reason).
		Set("\"statusChangedAt\" = ?", failedAt).
		Where("\"providerAccountId\" = ?", accountID).
		Where("model = ?", resolved).
		Exec(ctx)
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
		_, _ = s.db.NewUpdate().Model((*appdb.ProviderAccount)(nil)).Set("\"lastRecoveredByRotationAt\" = ?", recoveredAt).Where("id = ?", accountID).Where("\"lastErrorAt\" <= ?", failedAt).Exec(ctx)
	}
}

func (s *Service) insertErrorHistory(ctx context.Context, accountID, userID string, model *string, statusCode int, message string, now time.Time) error {
	row := appdb.ProviderAccountErrorHistory{ID: appdb.NewID(), ProviderAccountID: accountID, UserID: userID, Model: model, ErrorCode: statusCode, ErrorMessage: message, CreatedAt: now}
	if _, err := s.db.NewInsert().Model(&row).Exec(ctx); err != nil {
		return err
	}
	_, err := s.db.NewDelete().Model((*appdb.ProviderAccountErrorHistory)(nil)).Where("\"providerAccountId\" = ?", accountID).Where("id NOT IN (?)", s.db.NewSelect().Model((*appdb.ProviderAccountErrorHistory)(nil)).Column("id").Where("\"providerAccountId\" = ?", accountID).OrderExpr("\"createdAt\" DESC").Limit(maxErrorHistoryRows)).Exec(ctx)
	return err
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
		} else if account.Tier != nil && *account.Tier == "paid" {
			paid = append(paid, account)
		} else {
			free = append(free, account)
		}
	}
	return append(paid, free...)
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
