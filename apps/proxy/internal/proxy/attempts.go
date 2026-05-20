package proxy

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/opendum/opendum/apps/proxy/internal/auth"
	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
	"github.com/opendum/opendum/apps/proxy/internal/providers"
)

type accountRotationRunner interface {
	getNextAvailableAccount(context.Context, string, string, *string, []string, auth.AccountAccess) (*appdb.ProviderAccount, bool, error)
	getNextSharedAccount(context.Context, string, string, *string, []string) (*appdb.ProviderAccount, bool, error)
	reserveRoamingPoint(context.Context, string) (*pointReservation, bool, error)
	refundRoamingPoint(context.Context, *pointReservation)
	bumpAccountRequestCount(context.Context, string, time.Time)
	makeProviderRequest(context.Context, appdb.ProviderAccount, map[string]any, bool) (*http.Response, error)
	markAccountFailed(context.Context, string, string, int, string) time.Time
	markAccountUsageLimited(context.Context, string, string, time.Time, time.Time)
	logUsage(context.Context, usageParams)
	isVisionModel(string) bool
	isToolCallModel(string) bool
	canAccountUseModel(appdb.ProviderAccount, string) bool
}

type delayedAccountFailure struct {
	account    appdb.ProviderAccount
	statusCode int
	message    string
}

type accountAttempt struct {
	account *appdb.ProviderAccount
	roaming *pointReservation
}

func (s *Service) executeWithAccountRotation(ctx context.Context, r *http.Request, cfg endpointAdapter, parsed parsedEndpointRequest, authResult auth.Result, validation auth.ModelValidationResult, forced *appdb.ProviderAccount, startMS int64) (*appdb.ProviderAccount, *http.Response, int64, int64, []accountRotationFailure, *pointReservation, *routeError) {
	return executeAccountRotation(s, ctx, r, cfg, parsed, authResult, validation, forced, startMS)
}

func executeAccountRotation(runner accountRotationRunner, ctx context.Context, r *http.Request, cfg endpointAdapter, parsed parsedEndpointRequest, authResult auth.Result, validation auth.ModelValidationResult, forced *appdb.ProviderAccount, startMS int64) (*appdb.ProviderAccount, *http.Response, int64, int64, []accountRotationFailure, *pointReservation, *routeError) {
	tried := []string{}
	sharedTried := []string{}
	useShared := false
	recoverableFailures := []accountRotationFailure{}
	var lastFailure *routeError
	var delayedFinalFailure *delayedAccountFailure
	accountConfigured := false

	for {
		attempt := accountAttempt{account: forced}
		if attempt.account == nil {
			selected, configured, err := nextAttemptAccount(runner, ctx, authResult, validation, tried, sharedTried, useShared)
			if err != nil {
				return nil, nil, 0, 0, recoverableFailures, nil, &routeError{Status: http.StatusInternalServerError, Message: "Internal server error", Type: "api_error"}
			}
			accountConfigured = accountConfigured || configured
			attempt.account = selected
		}

		if attempt.account == nil && !useShared && forced == nil && authResult.RoamingEnabled {
			useShared = true
			continue
		}

		if attempt.account == nil {
			if lastFailure != nil && delayedFinalFailure != nil {
				runner.markAccountFailed(ctx, delayedFinalFailure.account.ID, validation.Model, delayedFinalFailure.statusCode, delayedFinalFailure.message)
			}
			if len(tried)+len(sharedTried) == 0 {
				if accountConfigured {
					return nil, nil, 0, 0, recoverableFailures, nil, &routeError{Status: http.StatusServiceUnavailable, Message: "This model is temporarily unavailable. Please try again later.", Type: "api_error"}
				}
				return nil, nil, 0, 0, recoverableFailures, nil, &routeError{Status: cfg.NoAccountsStatusCode, Message: "No active accounts available for this model. Please add an account in the dashboard.", Type: "configuration_error"}
			}
			if lastFailure != nil {
				return nil, nil, 0, 0, recoverableFailures, nil, lastFailure
			}
			return nil, nil, 0, 0, recoverableFailures, nil, &routeError{Status: http.StatusServiceUnavailable, Message: "No available accounts for this request.", Type: "api_error"}
		}
		if useShared && forced == nil {
			points, allowed, err := runner.reserveRoamingPoint(ctx, authResult.UserID)
			if err != nil {
				return nil, nil, 0, 0, recoverableFailures, nil, &routeError{Status: http.StatusInternalServerError, Message: "Internal server error", Type: "api_error"}
			}
			if !allowed {
				code := "insufficient_points"
				return nil, nil, 0, 0, recoverableFailures, nil, &routeError{Status: http.StatusPaymentRequired, Message: "Insufficient points. Please add more points to continue.", Type: "insufficient_quota", Code: &code}
			}
			attempt.roaming = points
		}

		if useShared {
			sharedTried = append(sharedTried, attempt.account.ID)
		} else {
			tried = append(tried, attempt.account.ID)
		}
		if forced != nil {
			go runner.bumpAccountRequestCount(context.Background(), attempt.account.ID, time.Now())
		}
		payload := cfg.Build(parsed, validation.Model, parsed.Stream, sessionID(r))
		if !runner.isVisionModel(validation.Model) {
			stripImageContent(payload)
		}
		if !runner.isToolCallModel(validation.Model) {
			stripToolCallParameters(payload)
		}
		requestStart := time.Now().UnixMilli()
		upstreamFirstResponseMS := int64(0)
		attemptCtx := providers.WithUpstreamResponseStartRecorder(ctx, func(at time.Time) {
			if upstreamFirstResponseMS == 0 {
				upstreamFirstResponseMS = at.UnixMilli()
			}
		})
		resp, err := runner.makeProviderRequest(attemptCtx, *attempt.account, payload, parsed.Stream)
		if upstreamFirstResponseMS == 0 && resp != nil {
			upstreamFirstResponseMS = time.Now().UnixMilli()
		}
		if err != nil {
			delayedFinalFailure = nil
			status := http.StatusInternalServerError
			message := err.Error()
			detailed := buildAccountErrorMessage(message, accountErrorContext{Model: validation.Model, Provider: attempt.account.Provider, Endpoint: endpointPath(cfg.Endpoint), Messages: parsed.MessagesForError, Parameters: parsed.ParamsForError})
			failedAt := runner.markAccountFailed(ctx, attempt.account.ID, validation.Model, status, detailed)
			runner.logUsage(ctx, usageParams{UserID: authResult.UserID, ProviderAccountID: attempt.account.ID, ProxyAPIKeyID: authResult.APIKeyID, Model: validation.Model, StatusCode: status, DurationMS: int(time.Now().UnixMilli() - startMS), Provider: attempt.account.Provider})
			lastFailure = &routeError{Status: status, Message: message, Type: "api_error"}
			if attempt.roaming != nil {
				runner.refundRoamingPoint(context.Background(), attempt.roaming)
			}
			if forced == nil {
				recoverableFailures = append(recoverableFailures, accountRotationFailure{AccountID: attempt.account.ID, FailedAt: failedAt})
				continue
			}
			return nil, nil, 0, 0, recoverableFailures, nil, lastFailure
		}

		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			bodyText := readBodyLimit(resp.Body, 1<<20)
			_ = resp.Body.Close()
			var failedAt time.Time
			delayedFinalFailure = nil
			if resp.StatusCode != http.StatusRequestTimeout {
				detailed := buildAccountErrorMessage(bodyText, accountErrorContext{Model: validation.Model, Provider: attempt.account.Provider, Endpoint: endpointPath(cfg.Endpoint), Messages: parsed.MessagesForError, Parameters: parsed.ParamsForError})
				if forced == nil && isAntigravityResourceExhausted(attempt.account.Provider, resp.StatusCode, bodyText) {
					delayedFinalFailure = &delayedAccountFailure{account: *attempt.account, statusCode: resp.StatusCode, message: detailed}
				} else {
					failedAt = runner.markAccountFailed(ctx, attempt.account.ID, validation.Model, resp.StatusCode, detailed)
					if disabledUntil, ok := codexUsageLimitDisabledUntil(attempt.account.Provider, resp.StatusCode, bodyText, failedAt); ok {
						runner.markAccountUsageLimited(ctx, attempt.account.ID, validation.Model, disabledUntil, failedAt)
					}
				}
			}
			runner.logUsage(ctx, usageParams{UserID: authResult.UserID, ProviderAccountID: attempt.account.ID, ProxyAPIKeyID: authResult.APIKeyID, Model: validation.Model, StatusCode: resp.StatusCode, DurationMS: int(time.Now().UnixMilli() - startMS), Provider: attempt.account.Provider})
			message, typ := sanitizedProxyError(resp.StatusCode, bodyText)
			lastFailure = &routeError{Status: resp.StatusCode, Message: message, Type: typ}
			if attempt.roaming != nil {
				runner.refundRoamingPoint(context.Background(), attempt.roaming)
			}
			if shouldRotate(resp.StatusCode) && forced == nil {
				if !failedAt.IsZero() {
					recoverableFailures = append(recoverableFailures, accountRotationFailure{AccountID: attempt.account.ID, FailedAt: failedAt})
				}
				continue
			}
			return nil, nil, 0, 0, recoverableFailures, nil, lastFailure
		}

		return attempt.account, resp, requestStart, upstreamFirstResponseMS, recoverableFailures, attempt.roaming, nil
	}
}

func nextAttemptAccount(runner accountRotationRunner, ctx context.Context, authResult auth.Result, validation auth.ModelValidationResult, tried, sharedTried []string, useShared bool) (*appdb.ProviderAccount, bool, error) {
	if useShared {
		return runner.getNextSharedAccount(ctx, authResult.UserID, validation.Model, validation.Provider, sharedTried)
	}
	return runner.getNextAvailableAccount(ctx, authResult.UserID, validation.Model, validation.Provider, tried, auth.AccountAccess{Mode: authResult.AccountAccessMode, Accounts: authResult.AccountAccessList})
}

func (s *Service) isVisionModel(model string) bool {
	if s.registry == nil {
		return true
	}
	return s.registry.IsVisionModel(model)
}

func (s *Service) isToolCallModel(model string) bool {
	if s.registry == nil {
		return true
	}
	return s.registry.IsToolCallModel(model)
}

func (s *Service) canAccountUseModel(account appdb.ProviderAccount, model string) bool {
	if s.registry == nil {
		return true
	}
	rule, ok := s.registry.ProviderAccessRule(model, account.Provider)
	if !ok || !accountAccessRuleRestrictsTier(rule.MinTier, rule.AllowedTiers) {
		return true
	}
	return accountTierSatisfiesRule(quotaFallbackTier(account), rule.MinTier, rule.AllowedTiers)
}

func accountTierSatisfiesRule(accountTier, minTier string, allowedTiers []string) bool {
	normalizedAccountTier := normalizeAccountTierAlias(accountTier)
	if len(allowedTiers) > 0 {
		for _, tier := range allowedTiers {
			if normalizeAccountTierAlias(tier) == normalizedAccountTier {
				return true
			}
		}
		return false
	}

	required := strings.ToLower(strings.TrimSpace(minTier))
	if required == "" || required == "free" {
		return true
	}
	return normalizedAccountTier == normalizeAccountTierAlias(required)
}

func accountAccessRuleRestrictsTier(minTier string, allowedTiers []string) bool {
	if len(allowedTiers) > 0 {
		return true
	}
	required := normalizeAccountTierAlias(minTier)
	return required != "" && required != "free"
}

func normalizeAccountTierAlias(tier string) string {
	normalized := strings.ToLower(strings.ReplaceAll(strings.TrimSpace(tier), "_", "-"))
	if normalized == "pro-plus" || normalized == "proplus" {
		return "pro+"
	}
	if normalized == "free-tier" || normalized == "free-limited-copilot" {
		return "free"
	}
	if normalized == "education" || normalized == "educational" || normalized == "edu" || normalized == "free-educational-quota" {
		return "student"
	}
	return normalized
}

func sessionID(r *http.Request) string {
	if value := r.Header.Get("session_id"); value != "" {
		return value
	}
	return r.Header.Get("x-session-id")
}
