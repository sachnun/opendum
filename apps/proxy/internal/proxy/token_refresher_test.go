package proxy

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/opendum/opendum/apps/proxy/internal/cryptojs"
	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
	"github.com/opendum/opendum/apps/proxy/internal/providers"
)

type testRefreshBufferProvider struct {
	buffer time.Duration
}

func (p testRefreshBufferProvider) RefreshBuffer() time.Duration { return p.buffer }

func (p testRefreshBufferProvider) MakeRequest(context.Context, *http.Client, string, appdb.ProviderAccount, map[string]any, bool) (*http.Response, error) {
	return nil, nil
}

type testCredentialRefreshProvider struct {
	testRefreshBufferProvider
	called bool
}

func (p *testCredentialRefreshProvider) RefreshCredentials(context.Context, *http.Client, string, appdb.ProviderAccount) (providers.RefreshedCredentials, error) {
	p.called = true
	return providers.RefreshedCredentials{}, nil
}

func TestAccountNeedsCredentialRefreshUsesProviderBuffer(t *testing.T) {
	now := time.Date(2026, 5, 10, 12, 0, 0, 0, time.UTC)
	provider := testRefreshBufferProvider{buffer: 30 * time.Minute}

	if !accountNeedsCredentialRefresh(appdb.ProviderAccount{ExpiresAt: now.Add(29 * time.Minute)}, provider, now) {
		t.Fatal("account expiring inside provider buffer should need refresh")
	}
	if accountNeedsCredentialRefresh(appdb.ProviderAccount{ExpiresAt: now.Add(31 * time.Minute)}, provider, now) {
		t.Fatal("account expiring outside provider buffer should not need refresh")
	}
}

func TestTokenRefreshLockKey(t *testing.T) {
	if got := tokenRefreshLockKey("acct_123"); got != "opendum:provider-account:refresh-lock:acct_123" {
		t.Fatalf("lock key = %q", got)
	}
}

func TestRefreshFailCountKey(t *testing.T) {
	if got := refreshFailCountKey("acct_123"); got != "opendum:provider-account:refresh-fail-count:acct_123" {
		t.Fatalf("fail count key = %q", got)
	}
}

func TestShouldDisableAccountAfterRefreshFailures(t *testing.T) {
	if shouldDisableAccountAfterRefreshFailures(4) {
		t.Fatal("4 failures should not disable")
	}
	if !shouldDisableAccountAfterRefreshFailures(5) {
		t.Fatal("5 failures should disable")
	}
	if !shouldDisableAccountAfterRefreshFailures(6) {
		t.Fatal("6 failures should disable")
	}
}

func TestParseRefreshErrorStatusCode(t *testing.T) {
	if got := parseRefreshErrorStatusCode(errors.New("codex token refresh failed: 400 invalid_grant")); got != 400 {
		t.Fatalf("status = %d, want 400", got)
	}
	if got := parseRefreshErrorStatusCode(errors.New("kiro token refresh failed: 503 service unavailable")); got != 503 {
		t.Fatalf("status = %d, want 503", got)
	}
	if got := parseRefreshErrorStatusCode(errors.New("network unreachable")); got != 401 {
		t.Fatalf("status = %d, want default 401", got)
	}
	if got := parseRefreshErrorStatusCode(nil); got != 401 {
		t.Fatalf("status = %d, want default 401", got)
	}
}

func TestRecordRefreshFailureWithoutDeps(t *testing.T) {
	service := &Service{}
	count, disabled := service.recordRefreshFailure(context.Background(), appdb.ProviderAccount{ID: "acct_123", Provider: "codex", IsActive: true}, errors.New("codex token refresh failed: 400 bad"))
	if count != 1 {
		t.Fatalf("count = %d, want 1 without redis", count)
	}
	if disabled {
		t.Fatal("should not disable without redis and db")
	}
	if count, disabled := service.recordRefreshFailure(context.Background(), appdb.ProviderAccount{ID: "acct_123", Provider: "codex", IsActive: false}, errors.New("codex token refresh failed: 400 bad")); count != 0 || disabled {
		t.Fatalf("inactive account should be skipped, got count=%d disabled=%v", count, disabled)
	}
	service.clearRefreshFailures(context.Background(), "acct_123")
	if disabled := service.disableAccountAfterRefreshFailures(context.Background(), "acct_123", time.Now()); disabled {
		t.Fatal("should not disable without db")
	}
}

func TestRefreshAccountCredentialsIfDueSkipsEmptyRefreshToken(t *testing.T) {
	secret := "test-secret"
	encryptedAccess, err := cryptojs.Encrypt(secret, "access-token")
	if err != nil {
		t.Fatal(err)
	}
	encryptedRefresh, err := cryptojs.Encrypt(secret, "")
	if err != nil {
		t.Fatal(err)
	}

	provider := &testCredentialRefreshProvider{testRefreshBufferProvider: testRefreshBufferProvider{buffer: time.Hour}}
	service := &Service{secret: secret}
	_, _, didRefresh, err := service.refreshAccountCredentialsIfDue(context.Background(), appdb.ProviderAccount{ID: "acct_123", AccessToken: encryptedAccess, RefreshToken: encryptedRefresh, ExpiresAt: time.Now().Add(-time.Minute)}, provider, false)
	if err != nil {
		t.Fatal(err)
	}
	if didRefresh {
		t.Fatal("empty refresh token account should not be refreshed")
	}
	if provider.called {
		t.Fatal("credential refresher should not be called for empty refresh token")
	}
}
