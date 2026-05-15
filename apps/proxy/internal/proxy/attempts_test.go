package proxy

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/opendum/opendum/apps/proxy/internal/auth"
	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
)

func TestExecuteAccountRotationContinuesPastFiveFailures(t *testing.T) {
	runner := &testRotationRunner{accounts: []appdb.ProviderAccount{
		{ID: "p1-a1", Provider: "provider_1"},
		{ID: "p1-a2", Provider: "provider_1"},
		{ID: "p1-a3", Provider: "provider_1"},
		{ID: "p1-a4", Provider: "provider_1"},
		{ID: "p1-a5", Provider: "provider_1"},
		{ID: "p2-a1", Provider: "provider_2"},
	}}
	request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	cfg := endpointAdapter{
		Endpoint:             "/v1/chat/completions",
		NoAccountsStatusCode: http.StatusTooManyRequests,
		Build: func(parsed parsedEndpointRequest, model string, stream bool, sessionID string) map[string]any {
			return map[string]any{"model": model, "stream": stream}
		},
	}

	account, resp, _, _, failures, routeErr := executeAccountRotation(
		runner,
		context.Background(),
		request,
		cfg,
		parsedEndpointRequest{Stream: false},
		auth.Result{UserID: "user_1"},
		auth.ModelValidationResult{Valid: true, Model: "unit-model"},
		nil,
		time.Now().UnixMilli(),
	)

	if routeErr != nil {
		t.Fatalf("executeAccountRotation routeErr = %+v", routeErr)
	}
	if account == nil || account.ID != "p2-a1" {
		t.Fatalf("selected account = %#v, want p2-a1", account)
	}
	if resp == nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("response = %#v, want 200", resp)
	}
	if len(failures) != 5 {
		t.Fatalf("recoverable failures = %d, want 5", len(failures))
	}
	if len(runner.requested) != 6 {
		t.Fatalf("provider requests = %#v, want 6 attempts", runner.requested)
	}
}

func TestSessionIDHeaderPrecedence(t *testing.T) {
	request := httptest.NewRequest("POST", "/v1/chat/completions", nil)
	request.Header.Set("session_id", "primary")
	request.Header.Set("x-session-id", "fallback")

	if got := sessionID(request); got != "primary" {
		t.Fatalf("sessionID = %q, want primary", got)
	}
}

func TestSessionIDFallsBackToXSessionID(t *testing.T) {
	request := httptest.NewRequest("POST", "/v1/chat/completions", nil)
	request.Header.Set("x-session-id", "fallback")

	if got := sessionID(request); got != "fallback" {
		t.Fatalf("sessionID = %q, want fallback", got)
	}
}

func TestFailedCooldownUntilUsesConfiguredCooldown(t *testing.T) {
	failedAt := time.Date(2026, 5, 11, 12, 0, 0, 0, time.UTC)
	want := failedAt.Add(10 * time.Minute)

	if got := failedCooldownUntil(failedAt); !got.Equal(want) {
		t.Fatalf("failedCooldownUntil() = %v, want %v", got, want)
	}
}

func TestExecuteAccountRotationMarksCodexUsageLimitDisabledUntil(t *testing.T) {
	now := time.Now()
	resetAt := now.Add(2 * time.Hour).Unix()
	runner := &testRotationRunner{
		accounts:     []appdb.ProviderAccount{{ID: "codex-account", Provider: "codex"}},
		responseBody: `{"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","plan_type":"free","resets_at":` + strconv.FormatInt(resetAt, 10) + `,"resets_in_seconds":7200}}`,
	}
	request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	cfg := endpointAdapter{
		Endpoint:             "/v1/chat/completions",
		NoAccountsStatusCode: http.StatusTooManyRequests,
		Build: func(parsed parsedEndpointRequest, model string, stream bool, sessionID string) map[string]any {
			return map[string]any{"model": model, "stream": stream}
		},
	}

	_, _, _, _, _, routeErr := executeAccountRotation(
		runner,
		context.Background(),
		request,
		cfg,
		parsedEndpointRequest{Stream: false},
		auth.Result{UserID: "user_1"},
		auth.ModelValidationResult{Valid: true, Model: "gpt-5.5", Provider: strPtr("codex")},
		nil,
		now.UnixMilli(),
	)

	if routeErr == nil || routeErr.Status != http.StatusTooManyRequests {
		t.Fatalf("routeErr = %+v, want 429", routeErr)
	}
	if runner.usageLimitedAccountID != "codex-account" {
		t.Fatalf("usageLimitedAccountID = %q, want codex-account", runner.usageLimitedAccountID)
	}
	if runner.usageLimitedModel != "gpt-5.5" {
		t.Fatalf("usageLimitedModel = %q, want gpt-5.5", runner.usageLimitedModel)
	}
	if got := runner.usageLimitedUntil.Unix(); got != resetAt {
		t.Fatalf("usageLimitedUntil = %d, want %d", got, resetAt)
	}
}

func TestExecuteAccountRotationDelaysAntigravityResourceExhaustedFailureOnRecovery(t *testing.T) {
	runner := &testRotationRunner{
		accounts: []appdb.ProviderAccount{
			{ID: "ag-a1", Provider: "antigravity"},
			{ID: "p2-a1", Provider: "provider_2"},
		},
		responseBody: antigravityResourceExhaustedBody,
	}
	request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	cfg := endpointAdapter{
		Endpoint:             "/v1/chat/completions",
		NoAccountsStatusCode: http.StatusTooManyRequests,
		Build: func(parsed parsedEndpointRequest, model string, stream bool, sessionID string) map[string]any {
			return map[string]any{"model": model, "stream": stream}
		},
	}

	account, resp, _, _, _, routeErr := executeAccountRotation(
		runner,
		context.Background(),
		request,
		cfg,
		parsedEndpointRequest{Stream: false},
		auth.Result{UserID: "user_1"},
		auth.ModelValidationResult{Valid: true, Model: "gemini-3-flash-preview", Provider: strPtr("antigravity")},
		nil,
		time.Now().UnixMilli(),
	)

	if routeErr != nil {
		t.Fatalf("executeAccountRotation routeErr = %+v", routeErr)
	}
	if account == nil || account.ID != "p2-a1" {
		t.Fatalf("selected account = %#v, want p2-a1", account)
	}
	if resp == nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("response = %#v, want 200", resp)
	}
	if len(runner.failedAccountIDs) != 0 {
		t.Fatalf("failed accounts = %#v, want none", runner.failedAccountIDs)
	}
}

func TestExecuteAccountRotationRecordsLastAntigravityResourceExhaustedFailure(t *testing.T) {
	runner := &testRotationRunner{
		accounts: []appdb.ProviderAccount{
			{ID: "ag-a1", Provider: "antigravity"},
			{ID: "ag-a2", Provider: "antigravity"},
		},
		responseBody: antigravityResourceExhaustedBody,
	}
	request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	cfg := endpointAdapter{
		Endpoint:             "/v1/chat/completions",
		NoAccountsStatusCode: http.StatusTooManyRequests,
		Build: func(parsed parsedEndpointRequest, model string, stream bool, sessionID string) map[string]any {
			return map[string]any{"model": model, "stream": stream}
		},
	}

	_, _, _, _, _, routeErr := executeAccountRotation(
		runner,
		context.Background(),
		request,
		cfg,
		parsedEndpointRequest{Stream: false},
		auth.Result{UserID: "user_1"},
		auth.ModelValidationResult{Valid: true, Model: "gemini-3-flash-preview", Provider: strPtr("antigravity")},
		nil,
		time.Now().UnixMilli(),
	)

	if routeErr == nil || routeErr.Status != http.StatusTooManyRequests {
		t.Fatalf("routeErr = %+v, want 429", routeErr)
	}
	if len(runner.failedAccountIDs) != 1 || runner.failedAccountIDs[0] != "ag-a2" {
		t.Fatalf("failed accounts = %#v, want only ag-a2", runner.failedAccountIDs)
	}
}

const antigravityResourceExhaustedBody = `{"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota).","status":"RESOURCE_EXHAUSTED"}}`

type testRotationRunner struct {
	accounts              []appdb.ProviderAccount
	requested             []string
	responseBody          string
	usageLimitedAccountID string
	usageLimitedModel     string
	usageLimitedUntil     time.Time
	failedAccountIDs      []string
}

func (r *testRotationRunner) getNextAvailableAccount(_ context.Context, _ string, _ string, _ *string, exclude []string, _ auth.AccountAccess) (*appdb.ProviderAccount, bool, error) {
	excluded := map[string]struct{}{}
	for _, id := range exclude {
		excluded[id] = struct{}{}
	}
	for i := range r.accounts {
		account := &r.accounts[i]
		if _, ok := excluded[account.ID]; !ok {
			return account, true, nil
		}
	}
	return nil, false, nil
}

func (r *testRotationRunner) bumpAccountRequestCount(context.Context, string, time.Time) {}

func (r *testRotationRunner) makeProviderRequest(_ context.Context, account appdb.ProviderAccount, _ map[string]any, _ bool) (*http.Response, error) {
	r.requested = append(r.requested, account.ID)
	if account.Provider == "provider_2" {
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(http.NoBody)}, nil
	}
	var body io.ReadCloser = http.NoBody
	if r.responseBody != "" {
		body = io.NopCloser(strings.NewReader(r.responseBody))
	}
	return &http.Response{StatusCode: http.StatusTooManyRequests, Body: body}, nil
}

func (r *testRotationRunner) markAccountFailed(_ context.Context, accountID string, _ string, _ int, _ string) time.Time {
	r.failedAccountIDs = append(r.failedAccountIDs, accountID)
	return time.Now()
}

func (r *testRotationRunner) markAccountUsageLimited(_ context.Context, accountID, model string, disabledUntil, _ time.Time) {
	r.usageLimitedAccountID = accountID
	r.usageLimitedModel = model
	r.usageLimitedUntil = disabledUntil
}

func (r *testRotationRunner) logUsage(context.Context, usageParams) {}

func (r *testRotationRunner) isVisionModel(string) bool { return false }

func (r *testRotationRunner) isToolCallModel(string) bool { return true }
