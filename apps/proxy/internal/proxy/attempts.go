package proxy

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/opendum/opendum/apps/proxy/internal/auth"
	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
)

func (s *Service) executeWithAccountRotation(ctx context.Context, r *http.Request, cfg endpointAdapter, parsed parsedEndpointRequest, authResult auth.Result, validation auth.ModelValidationResult, forced *appdb.ProviderAccount, startMS int64) (*appdb.ProviderAccount, *http.Response, int64, []accountRotationFailure, *routeError) {
	scope := rateLimitScope(validation.Model)
	tried := []string{}
	recoverableFailures := []accountRotationFailure{}
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
				return nil, nil, 0, recoverableFailures, &routeError{Status: http.StatusInternalServerError, Message: "Internal server error", Type: "api_error"}
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
						return nil, nil, 0, recoverableFailures, rateLimitRouteError(cfg, wait)
					}
				}
				return nil, nil, 0, recoverableFailures, &routeError{Status: cfg.NoAccountsStatusCode, Message: "No active accounts available for this model. Please add an account in the dashboard.", Type: "configuration_error"}
			}
			if wait := s.getMinWaitTime(ctx, tried, scope); wait > 0 {
				return nil, nil, 0, recoverableFailures, rateLimitRouteError(cfg, wait)
			}
			if lastFailure != nil {
				return nil, nil, 0, recoverableFailures, lastFailure
			}
			return nil, nil, 0, recoverableFailures, &routeError{Status: http.StatusServiceUnavailable, Message: "No available accounts for this request.", Type: "api_error"}
		}

		tried = append(tried, account.ID)
		if forced != nil {
			go s.bumpAccountRequestCount(context.Background(), account.ID, time.Now())
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
			detailed := buildAccountErrorMessage(message, accountErrorContext{Model: validation.Model, Provider: account.Provider, Endpoint: endpointPath(cfg.Endpoint), Messages: parsed.MessagesForError, Parameters: parsed.ParamsForError})
			failedAt := s.markAccountFailed(ctx, account.ID, validation.Model, status, detailed)
			s.logUsage(ctx, usageParams{UserID: authResult.UserID, ProviderAccountID: account.ID, ProxyAPIKeyID: authResult.APIKeyID, Model: validation.Model, StatusCode: status, DurationMS: int(time.Now().UnixMilli() - startMS), Provider: account.Provider})
			lastFailure = &routeError{Status: status, Message: message, Type: "api_error"}
			if attempt < maxRetries-1 {
				recoverableFailures = append(recoverableFailures, accountRotationFailure{AccountID: account.ID, FailedAt: failedAt})
				continue
			}
			return nil, nil, 0, recoverableFailures, lastFailure
		}

		if resp.StatusCode == http.StatusTooManyRequests {
			bodyText := readBodyLimit(resp.Body, 1<<20)
			retry := parseRetryAfter(resp, bodyText)
			if retry == 0 {
				retry = time.Hour
				if account.Provider == "kiro" {
					retry = time.Minute
				}
			}
			_ = resp.Body.Close()
			s.markRateLimited(ctx, account.ID, scope, retry, validation.Model, bodyText)
			s.logUsage(ctx, usageParams{UserID: authResult.UserID, ProviderAccountID: account.ID, ProxyAPIKeyID: authResult.APIKeyID, Model: validation.Model, StatusCode: http.StatusTooManyRequests, DurationMS: int(time.Now().UnixMilli() - startMS), Provider: account.Provider})
			continue
		}

		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			bodyText := readBodyLimit(resp.Body, 1<<20)
			_ = resp.Body.Close()
			var failedAt time.Time
			if resp.StatusCode != http.StatusRequestTimeout {
				detailed := buildAccountErrorMessage(bodyText, accountErrorContext{Model: validation.Model, Provider: account.Provider, Endpoint: endpointPath(cfg.Endpoint), Messages: parsed.MessagesForError, Parameters: parsed.ParamsForError})
				failedAt = s.markAccountFailed(ctx, account.ID, validation.Model, resp.StatusCode, detailed)
			}
			s.logUsage(ctx, usageParams{UserID: authResult.UserID, ProviderAccountID: account.ID, ProxyAPIKeyID: authResult.APIKeyID, Model: validation.Model, StatusCode: resp.StatusCode, DurationMS: int(time.Now().UnixMilli() - startMS), Provider: account.Provider})
			message, typ := sanitizedProxyError(resp.StatusCode, bodyText)
			lastFailure = &routeError{Status: resp.StatusCode, Message: message, Type: typ}
			if shouldRotate(resp.StatusCode) && attempt < maxRetries-1 {
				if !failedAt.IsZero() {
					recoverableFailures = append(recoverableFailures, accountRotationFailure{AccountID: account.ID, FailedAt: failedAt})
				}
				continue
			}
			return nil, nil, 0, recoverableFailures, lastFailure
		}

		return account, resp, requestStart, recoverableFailures, nil
	}

	if wait := s.getMinWaitTime(ctx, tried, scope); wait > 0 {
		return nil, nil, 0, recoverableFailures, rateLimitRouteError(cfg, wait)
	}
	if lastFailure != nil {
		return nil, nil, 0, recoverableFailures, lastFailure
	}
	return nil, nil, 0, recoverableFailures, &routeError{Status: http.StatusServiceUnavailable, Message: fmt.Sprintf("No available accounts for %s.", validation.Model), Type: "api_error"}
}

func sessionID(r *http.Request) string {
	if value := r.Header.Get("session_id"); value != "" {
		return value
	}
	return r.Header.Get("x-session-id")
}
