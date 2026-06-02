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

func TestCodexWindowGroupFormatsFreeDayWindows(t *testing.T) {
	tests := []struct {
		name          string
		windowMinutes float64
		want          string
	}{
		{name: "weekly", windowMinutes: 10080, want: "7d usage"},
		{name: "monthly", windowMinutes: 43200, want: "30d usage"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			group, ok := codexWindowGroup("primary", map[string]any{"used_percent": 25, "window_minutes": tt.windowMinutes}, "free", true)
			if !ok {
				t.Fatal("codexWindowGroup returned no group")
			}
			if group.DisplayName != tt.want {
				t.Fatalf("DisplayName = %q, want %q", group.DisplayName, tt.want)
			}
		})
	}
}

func TestGeminiQuotaGroupsHideProForFreeTier(t *testing.T) {
	payload := map[string]any{
		"buckets": []any{
			map[string]any{"modelId": "gemini-3.1-pro-preview", "remainingFraction": 0.5},
			map[string]any{"modelId": "gemini-2.5-flash", "remainingFraction": 0.8},
			map[string]any{"modelId": "gemini-3-flash-preview", "remainingFraction": 0.75},
		},
	}

	groups := geminiQuotaGroups(payload, "free-tier")
	if len(groups) != 2 {
		t.Fatalf("groups len = %d, want 2: %#v", len(groups), groups)
	}
	if groups[0].Name != "3-flash" || groups[1].Name != "25-flash" {
		t.Fatalf("group order = %v, want 3-flash, 25-flash", quotaGroupNames(groups))
	}
	flash := quotaGroupByName(groups, "3-flash")
	if flash == nil || flash.MaxRequests != 100 || flash.RemainingRequests != 75 {
		t.Fatalf("flash group = %#v", groups)
	}
}

func TestGeminiQuotaGroupsIncludeProForStandardTier(t *testing.T) {
	payload := map[string]any{
		"buckets": []any{
			map[string]any{"modelId": "gemini-3.1-pro-preview", "remainingFraction": 0.5},
			map[string]any{"modelId": "gemini-2.5-flash", "remainingFraction": 0.8},
			map[string]any{"modelId": "gemini-3-flash-preview", "remainingFraction": 0.75},
		},
	}

	groups := geminiQuotaGroups(payload, "standard-tier")
	if len(groups) != 3 {
		t.Fatalf("groups len = %d, want 3: %#v", len(groups), groups)
	}
	if groups[0].Name != "pro" || groups[1].Name != "3-flash" || groups[2].Name != "25-flash" {
		t.Fatalf("group order = %v, want pro, 3-flash, 25-flash", quotaGroupNames(groups))
	}
	pro := quotaGroupByName(groups, "pro")
	if pro == nil || pro.MaxRequests != 100 || pro.RemainingRequests != 50 {
		t.Fatalf("pro group = %#v", groups)
	}
	if pro.Models[0] != "gemini-3.1-pro-preview" || pro.Models[1] != "gemini-2.5-pro" {
		t.Fatalf("pro models = %v, want 3.1 pro before 2.5 pro", pro.Models)
	}
	flash := quotaGroupByName(groups, "3-flash")
	if flash == nil || flash.MaxRequests != 100 || flash.RemainingRequests != 75 {
		t.Fatalf("flash group = %#v", groups)
	}
}

func TestAntigravityQuotaGroupsKeepFrontierFirst(t *testing.T) {
	payload := map[string]any{
		"models": map[string]any{
			"gemini-3.1-pro-high":      map[string]any{"quotaInfo": map[string]any{"remainingFraction": 0.8}},
			"gemini-3.5-flash-medium":  map[string]any{"quotaInfo": map[string]any{"remainingFraction": 0.9}},
			"gpt-oss-120b-medium":      map[string]any{"quotaInfo": map[string]any{"remainingFraction": 0.7}},
			"claude-opus-4-6-thinking": map[string]any{"quotaInfo": map[string]any{"remainingFraction": 0.5}},
		},
	}

	groups := antigravityGroups(payload, "standard-tier")
	if len(groups) != 2 {
		t.Fatalf("groups len = %d, want 2: %#v", len(groups), groups)
	}
	if groups[0].Name != "claude" || groups[1].Name != "gemini" {
		t.Fatalf("group order = %v, want claude, gemini", quotaGroupNames(groups))
	}
	if groups[0].DisplayName != "Claude" || groups[1].DisplayName != "Gemini" {
		t.Fatalf("group labels = %q/%q, want Claude/Gemini", groups[0].DisplayName, groups[1].DisplayName)
	}
	if groups[0].RemainingFraction != 0.5 {
		t.Fatalf("claude remaining = %v, want claude shared bucket value 0.5", groups[0].RemainingFraction)
	}
	if groups[1].RemainingFraction != 0.8 {
		t.Fatalf("gemini remaining = %v, want pro shared bucket value 0.8", groups[1].RemainingFraction)
	}
	if groups[0].Models[2] != "gpt-oss-120b" || groups[1].Models[1] != "gemini-3.5-flash" {
		t.Fatalf("shared quota models = %v/%v", groups[0].Models, groups[1].Models)
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

func quotaGroupNames(groups []quotaGroupDisplay) []string {
	names := make([]string, 0, len(groups))
	for _, group := range groups {
		names = append(names, group.Name)
	}
	return names
}
