package proxy

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/opendum/opendum/apps/proxy/internal/auth"
	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
)

func (s *Service) tryProviders(ctx context.Context, r *http.Request, cfg routeConfig, parsed parsedRequest, authResult auth.Result, validation auth.ModelValidationResult, forced *appdb.ProviderAccount) (*appdb.ProviderAccount, *http.Response, int64, *routeError) {
	scope := rateLimitScope(validation.Model)
	tried := []string{}
	maxRetries := 5
	if forced != nil {
		maxRetries = 1
	}
	var lastFailure *routeError

	for attempt := 0; attempt < maxRetries; attempt++ {
		account := forced
		if account == nil {
			selected, err := s.getNextAvailableAccount(ctx, authResult.UserID, validation.Model, validation.Provider, tried, auth.AccountAccess{Mode: authResult.AccountAccessMode, Accounts: authResult.AccountAccessList})
			if err != nil {
				return nil, nil, 0, &routeError{Status: http.StatusInternalServerError, Message: "Internal server error", Type: "api_error"}
			}
			account = selected
		}

		if account == nil {
			if len(tried) == 0 {
				eligible, _ := s.getEligibleAccounts(ctx, authResult.UserID, validation.Model, validation.Provider, nil, auth.AccountAccess{Mode: authResult.AccountAccessMode, Accounts: authResult.AccountAccessList})
				if len(eligible) > 0 {
					ids := make([]string, 0, len(eligible))
					for _, acc := range eligible {
						ids = append(ids, acc.ID)
					}
					if wait := s.getMinWaitTime(ctx, ids, scope); wait > 0 {
						return nil, nil, 0, &routeError{Status: cfg.RateLimitStatusCode, Message: "All accounts are rate limited. Retry in " + formatWaitTime(wait) + ".", Type: "rate_limit_error"}
					}
				}
				return nil, nil, 0, &routeError{Status: cfg.NoAccountsStatusCode, Message: "No active accounts available for this model. Please add an account in the dashboard.", Type: "configuration_error"}
			}
			if wait := s.getMinWaitTime(ctx, tried, scope); wait > 0 {
				return nil, nil, 0, &routeError{Status: cfg.RateLimitStatusCode, Message: "All accounts are rate limited. Retry in " + formatWaitTime(wait) + ".", Type: "rate_limit_error"}
			}
			if lastFailure != nil {
				return nil, nil, 0, lastFailure
			}
			return nil, nil, 0, &routeError{Status: http.StatusServiceUnavailable, Message: "No available accounts for this request.", Type: "api_error"}
		}

		tried = append(tried, account.ID)
		if forced != nil {
			_, _ = s.db.NewUpdate().Model((*appdb.ProviderAccount)(nil)).Set("\"lastUsedAt\" = ?", time.Now()).Set("\"requestCount\" = \"requestCount\" + 1").Where("id = ?", account.ID).Exec(ctx)
		}

		payload := cfg.Build(parsed, validation.Model, parsed.Stream, sessionID(r))
		if !s.registry.IsVisionModel(validation.Model) {
			stripImageContent(payload)
		}
		requestStart := time.Now().UnixMilli()
		resp, err := s.makeProviderRequest(ctx, *account, payload, parsed.Stream)
		if err != nil {
			status := http.StatusInternalServerError
			message := err.Error()
			s.markAccountFailed(ctx, account.ID, validation.Model, status, message)
			s.logUsage(ctx, usageParams{UserID: authResult.UserID, ProviderAccountID: account.ID, ProxyAPIKeyID: authResult.APIKeyID, Model: validation.Model, StatusCode: status, DurationMS: int(time.Now().UnixMilli() - requestStart), Provider: account.Provider})
			lastFailure = &routeError{Status: status, Message: message, Type: "api_error"}
			if attempt < maxRetries-1 {
				continue
			}
			return nil, nil, 0, lastFailure
		}

		if resp.StatusCode == http.StatusTooManyRequests {
			retry := parseRetryAfter(resp)
			if retry == 0 {
				retry = time.Hour
				if account.Provider == "kiro" {
					retry = time.Minute
				}
			}
			bodyText := readBodyLimit(resp.Body, 1<<20)
			_ = resp.Body.Close()
			s.markRateLimited(ctx, account.ID, scope, retry, validation.Model, bodyText)
			s.logUsage(ctx, usageParams{UserID: authResult.UserID, ProviderAccountID: account.ID, ProxyAPIKeyID: authResult.APIKeyID, Model: validation.Model, StatusCode: http.StatusTooManyRequests, DurationMS: int(time.Now().UnixMilli() - requestStart), Provider: account.Provider})
			continue
		}

		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			bodyText := readBodyLimit(resp.Body, 1<<20)
			_ = resp.Body.Close()
			if resp.StatusCode != http.StatusRequestTimeout {
				s.markAccountFailed(ctx, account.ID, validation.Model, resp.StatusCode, bodyText)
			}
			s.logUsage(ctx, usageParams{UserID: authResult.UserID, ProviderAccountID: account.ID, ProxyAPIKeyID: authResult.APIKeyID, Model: validation.Model, StatusCode: resp.StatusCode, DurationMS: int(time.Now().UnixMilli() - requestStart), Provider: account.Provider})
			message, typ := sanitizedProxyError(resp.StatusCode, bodyText)
			lastFailure = &routeError{Status: resp.StatusCode, Message: message, Type: typ}
			if shouldRotate(resp.StatusCode) && attempt < maxRetries-1 {
				continue
			}
			return nil, nil, 0, lastFailure
		}

		return account, resp, requestStart, nil
	}

	if wait := s.getMinWaitTime(ctx, tried, scope); wait > 0 {
		return nil, nil, 0, &routeError{Status: cfg.RateLimitStatusCode, Message: "All accounts are rate limited. Retry in " + formatWaitTime(wait) + ".", Type: "rate_limit_error"}
	}
	if lastFailure != nil {
		return nil, nil, 0, lastFailure
	}
	return nil, nil, 0, &routeError{Status: http.StatusServiceUnavailable, Message: fmt.Sprintf("No available accounts for %s.", validation.Model), Type: "api_error"}
}

func sessionID(r *http.Request) string {
	if value := r.Header.Get("session_id"); value != "" {
		return value
	}
	return r.Header.Get("x-session-id")
}
