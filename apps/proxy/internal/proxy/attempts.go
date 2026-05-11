package proxy

import (
	"context"
	"net/http"
	"time"

	"github.com/opendum/opendum/apps/proxy/internal/auth"
	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
)

type accountRotationRunner interface {
	getNextAvailableAccount(context.Context, string, string, *string, []string, auth.AccountAccess) (*appdb.ProviderAccount, bool, error)
	bumpAccountRequestCount(context.Context, string, time.Time)
	makeProviderRequest(context.Context, appdb.ProviderAccount, map[string]any, bool) (*http.Response, error)
	markAccountFailed(context.Context, string, string, int, string) time.Time
	logUsage(context.Context, usageParams)
	isVisionModel(string) bool
}

func (s *Service) executeWithAccountRotation(ctx context.Context, r *http.Request, cfg endpointAdapter, parsed parsedEndpointRequest, authResult auth.Result, validation auth.ModelValidationResult, forced *appdb.ProviderAccount, startMS int64) (*appdb.ProviderAccount, *http.Response, int64, []accountRotationFailure, *routeError) {
	return executeAccountRotation(s, ctx, r, cfg, parsed, authResult, validation, forced, startMS)
}

func executeAccountRotation(runner accountRotationRunner, ctx context.Context, r *http.Request, cfg endpointAdapter, parsed parsedEndpointRequest, authResult auth.Result, validation auth.ModelValidationResult, forced *appdb.ProviderAccount, startMS int64) (*appdb.ProviderAccount, *http.Response, int64, []accountRotationFailure, *routeError) {
	tried := []string{}
	recoverableFailures := []accountRotationFailure{}
	var lastFailure *routeError
	accountConfigured := false

	for {
		account := forced
		if account == nil {
			selected, configured, err := runner.getNextAvailableAccount(ctx, authResult.UserID, validation.Model, validation.Provider, tried, auth.AccountAccess{Mode: authResult.AccountAccessMode, Accounts: authResult.AccountAccessList})
			if err != nil {
				return nil, nil, 0, recoverableFailures, &routeError{Status: http.StatusInternalServerError, Message: "Internal server error", Type: "api_error"}
			}
			accountConfigured = accountConfigured || configured
			account = selected
		}

		if account == nil {
			if len(tried) == 0 {
				if accountConfigured {
					return nil, nil, 0, recoverableFailures, &routeError{Status: http.StatusServiceUnavailable, Message: "This model is temporarily unavailable. Please try again later.", Type: "api_error"}
				}
				return nil, nil, 0, recoverableFailures, &routeError{Status: cfg.NoAccountsStatusCode, Message: "No active accounts available for this model. Please add an account in the dashboard.", Type: "configuration_error"}
			}
			if lastFailure != nil {
				return nil, nil, 0, recoverableFailures, lastFailure
			}
			return nil, nil, 0, recoverableFailures, &routeError{Status: http.StatusServiceUnavailable, Message: "No available accounts for this request.", Type: "api_error"}
		}

		tried = append(tried, account.ID)
		if forced != nil {
			go runner.bumpAccountRequestCount(context.Background(), account.ID, time.Now())
		}

		payload := cfg.Build(parsed, validation.Model, parsed.Stream, sessionID(r))
		if !runner.isVisionModel(validation.Model) {
			stripImageContent(payload)
		}
		requestStart := time.Now().UnixMilli()
		resp, err := runner.makeProviderRequest(ctx, *account, payload, parsed.Stream)
		if err != nil {
			status := http.StatusInternalServerError
			message := err.Error()
			detailed := buildAccountErrorMessage(message, accountErrorContext{Model: validation.Model, Provider: account.Provider, Endpoint: endpointPath(cfg.Endpoint), Messages: parsed.MessagesForError, Parameters: parsed.ParamsForError})
			failedAt := runner.markAccountFailed(ctx, account.ID, validation.Model, status, detailed)
			runner.logUsage(ctx, usageParams{UserID: authResult.UserID, ProviderAccountID: account.ID, ProxyAPIKeyID: authResult.APIKeyID, Model: validation.Model, StatusCode: status, DurationMS: int(time.Now().UnixMilli() - startMS), Provider: account.Provider})
			lastFailure = &routeError{Status: status, Message: message, Type: "api_error"}
			if forced == nil {
				recoverableFailures = append(recoverableFailures, accountRotationFailure{AccountID: account.ID, FailedAt: failedAt})
				continue
			}
			return nil, nil, 0, recoverableFailures, lastFailure
		}

		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			bodyText := readBodyLimit(resp.Body, 1<<20)
			_ = resp.Body.Close()
			var failedAt time.Time
			if resp.StatusCode != http.StatusRequestTimeout {
				detailed := buildAccountErrorMessage(bodyText, accountErrorContext{Model: validation.Model, Provider: account.Provider, Endpoint: endpointPath(cfg.Endpoint), Messages: parsed.MessagesForError, Parameters: parsed.ParamsForError})
				failedAt = runner.markAccountFailed(ctx, account.ID, validation.Model, resp.StatusCode, detailed)
			}
			runner.logUsage(ctx, usageParams{UserID: authResult.UserID, ProviderAccountID: account.ID, ProxyAPIKeyID: authResult.APIKeyID, Model: validation.Model, StatusCode: resp.StatusCode, DurationMS: int(time.Now().UnixMilli() - startMS), Provider: account.Provider})
			message, typ := sanitizedProxyError(resp.StatusCode, bodyText)
			lastFailure = &routeError{Status: resp.StatusCode, Message: message, Type: typ}
			if shouldRotate(resp.StatusCode) && forced == nil {
				if !failedAt.IsZero() {
					recoverableFailures = append(recoverableFailures, accountRotationFailure{AccountID: account.ID, FailedAt: failedAt})
				}
				continue
			}
			return nil, nil, 0, recoverableFailures, lastFailure
		}

		return account, resp, requestStart, recoverableFailures, nil
	}
}

func (s *Service) isVisionModel(model string) bool {
	if s.registry == nil {
		return false
	}
	return s.registry.IsVisionModel(model)
}

func sessionID(r *http.Request) string {
	if value := r.Header.Get("session_id"); value != "" {
		return value
	}
	return r.Header.Get("x-session-id")
}
