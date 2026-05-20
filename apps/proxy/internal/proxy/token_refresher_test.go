package proxy

import (
	"context"
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

func TestCopilotAccountNeedsCredentialRefreshForMissingOrLegacyTier(t *testing.T) {
	now := time.Date(2026, 5, 10, 12, 0, 0, 0, time.UTC)
	provider := testRefreshBufferProvider{buffer: 30 * time.Minute}
	legacyTier := "individual"
	proTier := "pro"

	if !accountNeedsCredentialRefresh(appdb.ProviderAccount{Provider: "copilot", Tier: &legacyTier, ExpiresAt: now.Add(24 * time.Hour)}, provider, now) {
		t.Fatal("copilot account with legacy tier should refresh even when token is not expiring")
	}
	if !accountNeedsCredentialRefresh(appdb.ProviderAccount{Provider: "copilot", ExpiresAt: now.Add(24 * time.Hour)}, provider, now) {
		t.Fatal("copilot account with missing tier should refresh even when token is not expiring")
	}
	if accountNeedsCredentialRefresh(appdb.ProviderAccount{Provider: "copilot", Tier: &proTier, ExpiresAt: now.Add(24 * time.Hour)}, provider, now) {
		t.Fatal("copilot account with canonical tier should not refresh before provider buffer")
	}
}

func TestTokenRefreshLockKey(t *testing.T) {
	if got := tokenRefreshLockKey("acct_123"); got != "opendum:provider-account:refresh-lock:acct_123" {
		t.Fatalf("lock key = %q", got)
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
