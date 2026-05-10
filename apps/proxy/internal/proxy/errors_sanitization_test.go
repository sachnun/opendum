package proxy

import (
	"strings"
	"testing"
)

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
