package proxy

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
)

func TestQuotaRawCacheKeyDoesNotExposeAuthorization(t *testing.T) {
	account := appdb.ProviderAccount{ID: "acct_1", Provider: "codex"}
	key := quotaRawCacheKey(account, "codex:usage", http.MethodGet, "https://chatgpt.com/backend-api/wham/usage", []byte(`{"token":"secret-token"}`))

	for _, secret := range []string{"Bearer", "secret-token"} {
		if strings.Contains(key, secret) {
			t.Fatalf("cache key %q contains secret fragment %q", key, secret)
		}
	}
	if !strings.HasPrefix(key, "opendum:quota:raw:codex:acct_1:") {
		t.Fatalf("cache key = %q, want quota raw prefix", key)
	}
}

func TestQuotaCacheHeadersKeepsCodexQuotaHeadersOnly(t *testing.T) {
	headers := http.Header{}
	headers.Set("x-codex-primary-used-percent", "42")
	headers.Set("x-codex-primary-window-minutes", "300")
	headers.Set("set-cookie", "private")
	headers.Set("authorization", "Bearer response-token")

	cached := quotaCacheHeaders(headers)
	if cached["X-Codex-Primary-Used-Percent"][0] != "42" || cached["X-Codex-Primary-Window-Minutes"][0] != "300" {
		t.Fatalf("cached headers missing codex quota headers: %#v", cached)
	}
	if _, ok := cached["set-cookie"]; ok {
		t.Fatalf("cached headers should not include set-cookie: %#v", cached)
	}
	if _, ok := cached["authorization"]; ok {
		t.Fatalf("cached headers should not include authorization: %#v", cached)
	}
}

func TestQuotaRawCacheTTLRangesFromOneToFiveMinutes(t *testing.T) {
	for range 100 {
		ttl := quotaRawCacheTTL()
		if ttl < time.Minute || ttl > 5*time.Minute {
			t.Fatalf("quotaRawCacheTTL() = %s, want 1m..5m", ttl)
		}
	}
}

func TestQuotaRequestAcceptsForceRefresh(t *testing.T) {
	var req quotaRequest
	decoder := json.NewDecoder(bytes.NewReader([]byte(`{"userId":"user_1","provider":"codex","accountId":"acct_1","forceRefresh":true}`)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		t.Fatalf("quotaRequest decode returned error: %v", err)
	}
	if !req.ForceRefresh {
		t.Fatal("ForceRefresh = false, want true")
	}
}

func TestGeminiQuotaGroupsHideProForFreeTier(t *testing.T) {
	payload := map[string]any{
		"buckets": []any{
			map[string]any{"modelId": "gemini-3.1-pro-preview", "remainingFraction": 0.5},
			map[string]any{"modelId": "gemini-3-flash-preview", "remainingFraction": 0.75},
		},
	}

	groups := geminiQuotaGroups(payload, "free-tier")
	if len(groups) != 1 {
		t.Fatalf("groups len = %d, want 1: %#v", len(groups), groups)
	}
	flash := quotaGroupByName(groups, "3-flash")
	if flash == nil || flash.MaxRequests != 100 || flash.RemainingRequests != 75 {
		t.Fatalf("flash group = %#v", groups[0])
	}
}

func TestGeminiQuotaGroupsIncludeProForStandardTier(t *testing.T) {
	payload := map[string]any{
		"buckets": []any{
			map[string]any{"modelId": "gemini-3.1-pro-preview", "remainingFraction": 0.5},
			map[string]any{"modelId": "gemini-3-flash-preview", "remainingFraction": 0.75},
		},
	}

	groups := geminiQuotaGroups(payload, "standard-tier")
	if len(groups) != 2 {
		t.Fatalf("groups len = %d, want 2: %#v", len(groups), groups)
	}
	pro := quotaGroupByName(groups, "pro")
	if pro == nil || pro.MaxRequests != 100 || pro.RemainingRequests != 50 {
		t.Fatalf("pro group = %#v", groups)
	}
	flash := quotaGroupByName(groups, "3-flash")
	if flash == nil || flash.MaxRequests != 100 || flash.RemainingRequests != 75 {
		t.Fatalf("flash group = %#v", groups)
	}
}

func quotaGroupByName(groups []quotaGroupDisplay, name string) *quotaGroupDisplay {
	for i := range groups {
		if groups[i].Name == name {
			return &groups[i]
		}
	}
	return nil
}
