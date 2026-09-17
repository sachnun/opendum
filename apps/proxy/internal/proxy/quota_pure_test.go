package proxy

import (
	"encoding/base64"
	"net/http"
	"strings"
	"testing"
)

func TestNormalizeAntigravityQuotaTier(t *testing.T) {
	t.Parallel()
	cases := map[string]string{
		"standard-tier": "standard-tier",
		"paid":          "standard-tier",
		"legacy-tier":   "legacy-tier",
		"free-tier":     "free-tier",
		"FREE":          "free-tier",
		"  Pro  ":       "pro",
	}
	for input, want := range cases {
		if got := normalizeAntigravityQuotaTier(input); got != want {
			t.Errorf("normalizeAntigravityQuotaTier(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestAntigravityMaxRequests(t *testing.T) {
	t.Parallel()
	if got := antigravityMaxRequests("claude-opus-4-6", "standard-tier"); got != 150 {
		t.Fatalf("standard claude = %v, want 150", got)
	}
	if got := antigravityMaxRequests("claude-opus-4-6", "free-tier"); got != 50 {
		t.Fatalf("free claude = %v, want 50", got)
	}
	if got := antigravityMaxRequests("unknown-model", "standard-tier"); got != 100 {
		t.Fatalf("unknown model = %v, want 100", got)
	}
}

func TestAntigravityGroups(t *testing.T) {
	t.Parallel()
	payload := map[string]any{"models": map[string]any{
		"claude-opus-4-6-thinking": map[string]any{"quotaInfo": map[string]any{"remainingFraction": 0.5}},
		"gemini-3.1-pro-high":      map[string]any{"quotaInfo": map[string]any{"remainingFraction": 0.25}},
	}}
	groups := antigravityGroups(payload, "free-tier")
	if len(groups) != 2 {
		t.Fatalf("groups = %d, want 2", len(groups))
	}
	claude := findQuotaGroup(groups, "claude")
	if claude == nil || claude.RemainingLabel == nil || *claude.RemainingLabel != "50%" {
		t.Fatalf("claude = %+v", claude)
	}
	gemini := findQuotaGroup(groups, "gemini")
	if gemini == nil || gemini.RemainingLabel == nil || *gemini.RemainingLabel != "25%" {
		t.Fatalf("gemini = %+v", gemini)
	}

	empty := antigravityGroups(map[string]any{}, "free-tier")
	for _, group := range empty {
		if group.RemainingLabel == nil || *group.RemainingLabel != "100%" {
			t.Fatalf("missing quota info should default to full: %+v", group)
		}
	}
}

func TestParseResetISO(t *testing.T) {
	t.Parallel()
	if got := parseResetISO("2023-11-14T22:13:20Z"); got == nil || !strings.Contains(*got, "2023-11-14") {
		t.Fatalf("string = %v", got)
	}
	if got := parseResetISO(float64(1_700_000_000)); got == nil || !strings.Contains(*got, "2023-11-14") {
		t.Fatalf("seconds float = %v", got)
	}
	if got := parseResetISO(float64(1_700_000_000_000)); got == nil || !strings.Contains(*got, "2023-11-14") {
		t.Fatalf("millis float = %v", got)
	}
	if got := parseResetISO(map[string]any{"seconds": float64(1_700_000_000)}); got == nil || !strings.Contains(*got, "2023-11-14") {
		t.Fatalf("map seconds = %v", got)
	}
	for _, invalid := range []any{nil, "not-a-time"} {
		if got := parseResetISO(invalid); got != nil {
			t.Errorf("parseResetISO(%v) = %v, want nil", invalid, *got)
		}
	}
}

func TestFormatFloat(t *testing.T) {
	t.Parallel()
	if got := formatFloat(5); got != "5" {
		t.Fatalf("formatFloat(5) = %q, want 5", got)
	}
	if got := formatFloat(5.5); got != "5.50" {
		t.Fatalf("formatFloat(5.5) = %q, want 5.50", got)
	}
}

func TestResetISOFromMillis(t *testing.T) {
	t.Parallel()
	if got := resetISOFromMillis(0); got != nil {
		t.Fatalf("zero = %v, want nil", got)
	}
	if got := resetISOFromMillis(-1); got != nil {
		t.Fatalf("negative = %v, want nil", got)
	}
	if got := resetISOFromMillis(1_700_000_000_000); got == nil || !strings.Contains(*got, "2023-11-14") {
		t.Fatalf("millis = %v", got)
	}
}

func TestExtractQuotaAccountIDFromJWT(t *testing.T) {
	t.Parallel()
	encode := func(claims string) string {
		return "header." + base64.RawURLEncoding.EncodeToString([]byte(claims)) + ".sig"
	}
	if got := extractQuotaAccountIDFromJWT(encode(`{"https://api.openai.com/auth":{"chatgpt_workspace_id":"ws_1"}}`)); got != "ws_1" {
		t.Fatalf("auth claim = %q, want ws_1", got)
	}
	if got := extractQuotaAccountIDFromJWT(encode(`{"workspace_id":"ws_2"}`)); got != "ws_2" {
		t.Fatalf("top-level claim = %q, want ws_2", got)
	}
	if got := extractQuotaAccountIDFromJWT(encode(`{}`)); got != "" {
		t.Fatalf("no claim = %q, want empty", got)
	}
	for _, invalid := range []string{"onlyone", "a.!!!.c", ""} {
		if got := extractQuotaAccountIDFromJWT(invalid); got != "" {
			t.Errorf("extractQuotaAccountIDFromJWT(%q) = %q, want empty", invalid, got)
		}
	}
}

func TestCodexWindowDisplayName(t *testing.T) {
	t.Parallel()
	cases := map[float64]string{
		300:  "5 hour usage",
		1440: "1d usage",
		2880: "2d usage",
		60:   "1 hour usage",
		90:   "90m usage",
	}
	for minutes, want := range cases {
		if got := codexWindowDisplayName(minutes); got != want {
			t.Errorf("codexWindowDisplayName(%v) = %q, want %q", minutes, got, want)
		}
	}
}

func TestCodexWindowGroup(t *testing.T) {
	t.Parallel()
	primary, ok := codexWindowGroup("primary", map[string]any{"used_percent": 25.0, "window_minutes": 300.0}, "free", true)
	if !ok {
		t.Fatal("primary window not built")
	}
	if primary.DisplayName != "5 hour usage" || primary.PercentUsed != 25 {
		t.Fatalf("primary = %+v", primary)
	}
	if primary.RemainingFraction != 0.75 || primary.IsExhausted {
		t.Fatalf("primary remaining = %+v", primary)
	}

	secondary, ok := codexWindowGroup("secondary", map[string]any{"used_percent": 50.0}, "free", true)
	if !ok || secondary.DisplayName != "Weekly usage" {
		t.Fatalf("secondary = %+v", secondary)
	}

	exhausted, ok := codexWindowGroup("primary", map[string]any{"used_percent": 100.0}, "free", true)
	if !ok || !exhausted.IsExhausted || exhausted.RemainingFraction != 0 {
		t.Fatalf("exhausted = %+v", exhausted)
	}

	if _, ok := codexWindowGroup("primary", map[string]any{}, "free", true); ok {
		t.Fatal("missing used_percent should not produce a group")
	}
}

func TestParseCodexQuotaHeaderGroups(t *testing.T) {
	t.Parallel()
	headers := http.Header{
		"X-Codex-Primary-Used-Percent":   []string{"10"},
		"X-Codex-Primary-Window-Minutes": []string{"300"},
		"X-Codex-Primary-Reset-At":       []string{"1700000000"},
	}
	groups := parseCodexQuotaHeaderGroups(headers, "free")
	if len(groups) != 1 {
		t.Fatalf("groups = %d, want 1", len(groups))
	}
	if groups[0].DisplayName != "5 hour usage" || groups[0].PercentUsed != 10 {
		t.Fatalf("group = %+v", groups[0])
	}
	if groups[0].ResetTimeIso == nil {
		t.Fatal("reset time not parsed")
	}
}

func TestKiroGroups(t *testing.T) {
	t.Parallel()
	record := map[string]any{"limits": []any{
		map[string]any{"type": "AI_EDITOR", "currentUsage": 100.0, "totalUsageLimit": 200.0, "nextDateReset": float64(1_700_000_000)},
		map[string]any{"type": "", "currentUsage": 1.0, "totalUsageLimit": 2.0},
	}}
	groups := kiroGroups(record)
	if len(groups) != 1 {
		t.Fatalf("groups = %d, want 1 (empty type skipped)", len(groups))
	}
	if groups[0].Name != "ai_editor" || groups[0].DisplayName != "Kiro requests" {
		t.Fatalf("group = %+v", groups[0])
	}
	if groups[0].RemainingFraction != 0.5 || groups[0].PercentUsed != 50 {
		t.Fatalf("group fraction/percent = %+v", groups[0])
	}
}

func TestTitleWords(t *testing.T) {
	t.Parallel()
	if got := titleWords("hello world"); got != "Hello World" {
		t.Fatalf("titleWords = %q, want Hello World", got)
	}
	if got := titleWords(""); got != "" {
		t.Fatalf("titleWords empty = %q, want empty", got)
	}
}
