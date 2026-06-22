package proxy

import (
	"strings"
	"testing"
)

func TestProviderDisplayName(t *testing.T) {
	cases := []struct {
		provider string
		want     string
	}{
		{"antigravity", "Antigravity"},
		{"copilot", "Copilot"},
		{"codex", "Codex"},
		{"command_code", "Command Code"},
		{"kiro", "Kiro"},
		{"nvidia_nim", "Nvidia"},
		{"openrouter", "OpenRouter"},
		{"workers_ai", "Cloudflare"},
		{"qoder", "Qoder"},
		{"zenmux", "ZenMux"},
		{"siliconflow", "SiliconFlow"},
		{"opencode", "Opencode"},
		{"kilo_code", "Kilo Code"},
		{"mimo_code", "MiMo Code"},
		{"", ""},
		{"unknown_provider", "unknown_provider"},
	}
	for _, tc := range cases {
		t.Run(tc.provider, func(t *testing.T) {
			if got := providerDisplayName(tc.provider); got != tc.want {
				t.Fatalf("providerDisplayName(%q) = %q, want %q", tc.provider, got, tc.want)
			}
		})
	}
}

func TestPrefixWithProvider(t *testing.T) {
	cases := []struct {
		name     string
		provider string
		message  string
		want     string
	}{
		{
			name:     "known provider",
			provider: "siliconflow",
			message:  "Sorry, your account balance is insufficient.",
			want:     "[SiliconFlow] Sorry, your account balance is insufficient.",
		},
		{
			name:     "workers_ai alias",
			provider: "workers_ai",
			message:  "rate limit exceeded",
			want:     "[Cloudflare] rate limit exceeded",
		},
		{
			name:     "unknown provider",
			provider: "made_up",
			message:  "boom",
			want:     "[made_up] boom",
		},
		{
			name:     "empty provider",
			provider: "",
			message:  "boom",
			want:     "boom",
		},
		{
			name:     "empty message",
			provider: "siliconflow",
			message:  "",
			want:     "",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := prefixWithProvider(tc.provider, tc.message)
			if got != tc.want {
				t.Fatalf("prefixWithProvider(%q, %q) = %q, want %q", tc.provider, tc.message, got, tc.want)
			}
		})
	}
}

func TestSanitizeParametersForErrorRedactsAndSummarizes(t *testing.T) {
	params := map[string]any{
		"messages": []any{map[string]any{"role": "user", "content": "secret"}},
		"tools": []any{
			map[string]any{"function": map[string]any{"name": "lookup"}},
			map[string]any{"name": "search"},
		},
		"prompt": strings.Repeat("a", accountErrorTextLimit+1),
		"metadata": map[string]any{
			"nested": strings.Repeat("b", accountErrorTextLimit+1),
		},
	}

	sanitized := sanitizeParametersForError(params)
	if sanitized["messages"] != "[redacted: see \"Messages (object keys only)\"]" {
		t.Fatalf("messages were not redacted: %#v", sanitized["messages"])
	}
	if sanitized["tools"] != "[2 tool(s): lookup, search]" {
		t.Fatalf("tools summary = %#v", sanitized["tools"])
	}
	if prompt, _ := sanitized["prompt"].(string); !strings.HasSuffix(prompt, "...[truncated, 201 chars total]") {
		t.Fatalf("prompt was not truncated: %q", prompt)
	}
	nested := sanitized["metadata"].(map[string]any)["nested"].(string)
	if !strings.HasSuffix(nested, "...[truncated, 201 chars total]") {
		t.Fatalf("nested value was not truncated: %q", nested)
	}
}
