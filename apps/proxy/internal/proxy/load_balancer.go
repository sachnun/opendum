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
	failedCooldown      = 10 * time.Minute
	degradedThreshold   = 3
	failedThreshold     = 7
	maxStoredErrorLen   = 10000
	maxErrorHistoryRows = 200
)

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

	query := s.db.NewSelect().Model((*appdb.ProviderAccount)(nil)).
		Column("id", "userId", "provider", "tier", "status", "lastUsedAt", "createdAt", "accountId").
		Where("\"userId\" = ?", userID).
		Where("provider IN (?)", bun.In(targetProviders)).
		Where("\"isActive\" = TRUE")
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

	var rows []appdb.ProviderAccount
	if err := query.OrderExpr("status ASC").OrderExpr("\"lastUsedAt\" ASC NULLS FIRST").OrderExpr("\"createdAt\" ASC").Scan(ctx, &rows); err != nil {
		return nil, err
	}
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
		if _, disabled := disabledSet[row.ID]; !disabled {
			enabled = append(enabled, row)
		}
	}
	if provider == nil {
		sortAccountsByProviderPriority(enabled, targetProviders)
	}
	return enabled, nil
}

func (s *Service) getNextAvailableAccount(ctx context.Context, userID, model string, provider *string, exclude []string, accountAccess auth.AccountAccess) (*appdb.ProviderAccount, error) {
	eligible, err := s.getEligibleAccounts(ctx, userID, model, provider, exclude, accountAccess)
	if err != nil || len(eligible) == 0 {
		return nil, err
	}
	prioritized := prioritizeAccounts(eligible, provider == nil, s.registry.ProvidersForModel(model))
	ids := make([]string, 0, len(prioritized))
	for _, account := range prioritized {
		ids = append(ids, account.ID)
	}
	limited := s.getRateLimitedAccountIDs(ctx, ids, rateLimitScope(model))
	health, err := s.getHealthByAccount(ctx, ids, s.registry.LookupKeys(model))
	if err != nil {
		return nil, err
	}

	now := time.Now()
	var selected *appdb.ProviderAccount
	for i := range prioritized {
		account := &prioritized[i]
		if _, ok := limited[account.ID]; ok {
			continue
		}
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
		return nil, nil
	}
	go s.bumpAccountRequestCount(context.Background(), selected.ID, now)
	return selected, nil
}

func (s *Service) bumpAccountRequestCount(ctx context.Context, accountID string, usedAt time.Time) {
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

func (s *Service) validateForcedAccount(ctx context.Context, userID string, validation auth.ModelValidationResult, providerAccountID *string, accountAccess auth.AccountAccess, cfg endpointAdapter) (*appdb.ProviderAccount, *routeError) {
	if providerAccountID == nil {
		return nil, nil
	}
	id := strings.TrimSpace(*providerAccountID)
	param := "provider_account_id"
	if id == "" {
		return nil, &routeError{Status: http.StatusBadRequest, Message: "provider_account_id must be a non-empty string", Type: "invalid_request_error", Param: &param, Code: strPtr("invalid_provider_account")}
	}
	var account appdb.ProviderAccount
	err := s.db.NewSelect().Model(&account).Column("id", "userId", "provider", "tier", "status", "lastUsedAt", "createdAt", "accountId", "isActive").Where("id = ?", id).Where("\"userId\" = ?", userID).Limit(1).Scan(ctx)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, &routeError{Status: http.StatusBadRequest, Message: "Selected provider account was not found", Type: "invalid_request_error", Param: &param, Code: strPtr("provider_account_not_found")}
		}
		return nil, &routeError{Status: http.StatusInternalServerError, Message: "Internal server error", Type: "api_error"}
	}
	if !account.IsActive {
		return nil, &routeError{Status: http.StatusBadRequest, Message: "Selected provider account is inactive", Type: "invalid_request_error", Param: &param, Code: strPtr("provider_account_inactive")}
	}
	if err := accountAllowed(account.ID, accountAccess); err != nil {
		return nil, &routeError{Status: http.StatusForbidden, Message: err.Error(), Type: "invalid_request_error", Param: &param, Code: strPtr("provider_account_not_allowed")}
	}
	if !s.registry.IsSupportedByProvider(validation.Model, account.Provider) {
		return nil, &routeError{Status: http.StatusBadRequest, Message: "Selected account provider \"" + account.Provider + "\" does not support model \"" + validation.Model + "\"", Type: "invalid_request_error", Param: &param, Code: strPtr("provider_account_model_mismatch")}
	}
	if validation.Provider != nil && account.Provider != *validation.Provider {
		return nil, &routeError{Status: http.StatusBadRequest, Message: "Selected account provider \"" + account.Provider + "\" does not match model provider \"" + *validation.Provider + "\"", Type: "invalid_request_error", Param: &param, Code: strPtr("provider_account_provider_mismatch")}
	}
	if s.isRateLimited(ctx, account.ID, rateLimitScope(validation.Model)) {
		wait := s.getMinWaitTime(ctx, []string{account.ID}, rateLimitScope(validation.Model))
		message := "Selected account is rate limited."
		if wait > 0 {
			message = "Selected account is rate limited. Retry in " + formatWaitTime(wait) + "."
		}
		return nil, &routeError{Status: cfg.RateLimitStatusCode, Message: message, Type: "rate_limit_error"}
	}
	return &account, nil
}

func (s *Service) markAccountSuccess(ctx context.Context, accountID, model string) {
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
		}
	}

	var account appdb.ProviderAccount
	if err := s.db.NewSelect().Model(&account).Column("userId").Where("id = ?", accountID).Limit(1).Scan(ctx); err == nil {
		modelValue := resolved
		_ = s.insertErrorHistory(ctx, accountID, account.UserID, &modelValue, statusCode, message, now)
	}
	return now
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
		if account.Tier != nil && *account.Tier == "paid" {
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
	mode := normalizeAccessMode(access.Mode)
	set := map[string]struct{}{}
	for _, id := range normalizeAccountIDs(access.Accounts) {
		set[id] = struct{}{}
	}
	if mode == "whitelist" {
		if _, ok := set[accountID]; !ok {
			return errors.New("Selected provider account is not allowed for this API key.")
		}
	}
	if mode == "blacklist" {
		if _, ok := set[accountID]; ok {
			return errors.New("Selected provider account is blocked for this API key.")
		}
	}
	return nil
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
