package proxy

import (
	"context"
	"net/http"
	"testing"
	"time"

	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
)

type testRefreshBufferProvider struct {
	buffer time.Duration
}

func (p testRefreshBufferProvider) RefreshBuffer() time.Duration { return p.buffer }

func (p testRefreshBufferProvider) MakeRequest(context.Context, *http.Client, string, appdb.ProviderAccount, map[string]any, bool) (*http.Response, error) {
	return nil, nil
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
