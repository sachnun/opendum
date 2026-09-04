package providers

import (
	"encoding/json"
	"testing"
)

func TestOpenAIToGeminiFunctionResponseNameFromHistory(t *testing.T) {
	body := map[string]any{
		"messages": []any{
			map[string]any{"role": "user", "content": "list files"},
			map[string]any{"role": "assistant", "content": "", "tool_calls": []any{
				map[string]any{"id": "call_1", "type": "function", "function": map[string]any{"name": "bash", "arguments": `{"command":"ls"}`}},
			}},
			map[string]any{"role": "tool", "tool_call_id": "call_1", "content": "file1.txt"},
		},
	}
	payload := openAIToGemini(body)
	contents, _ := payload["contents"].([]any)
	var found string
	for _, raw := range contents {
		content, _ := raw.(map[string]any)
		for _, rawPart := range anySlice(content["parts"]) {
			part, _ := rawPart.(map[string]any)
			if fn, ok := part["functionResponse"].(map[string]any); ok {
				found, _ = fn["name"].(string)
			}
		}
	}
	if found != "bash" {
		t.Fatalf("functionResponse.name = %q, want %q", found, "bash")
	}
}

func TestOpenAIToGeminiDropsEmptyAssistantTextContent(t *testing.T) {
	body := map[string]any{
		"messages": []any{
			map[string]any{"role": "user", "content": "list files"},
			map[string]any{"role": "assistant", "content": "", "tool_calls": []any{
				map[string]any{"id": "call_1", "type": "function", "function": map[string]any{"name": "bash", "arguments": `{"command":"ls"}`}},
			}},
			map[string]any{"role": "tool", "tool_call_id": "call_1", "content": "file1.txt"},
			map[string]any{"role": "user", "content": "thanks"},
		},
	}
	payload := openAIToGemini(body)
	contents, _ := payload["contents"].([]any)
	for _, raw := range contents {
		content, _ := raw.(map[string]any)
		parts := anySlice(content["parts"])
		if content["role"] == "model" && len(parts) == 0 {
			t.Fatalf("found model content with empty parts: %s", jsonify(payload))
		}
		for _, rawPart := range parts {
			part, _ := rawPart.(map[string]any)
			if text, ok := part["text"].(string); ok && text == "" {
				t.Fatalf("found empty text part: %s", jsonify(payload))
			}
		}
	}
}

func TestGeminiUsageMapsCachedContentTokens(t *testing.T) {
	usage := geminiUsage(map[string]any{
		"usageMetadata": map[string]any{
			"promptTokenCount":        1000,
			"candidatesTokenCount":    200,
			"totalTokenCount":         1200,
			"cachedContentTokenCount": 400,
			"thoughtsTokenCount":      50,
		},
	})
	if usage == nil {
		t.Fatal("geminiUsage returned nil")
	}
	if usage["prompt_tokens"] != 1000 || usage["completion_tokens"] != 200 || usage["total_tokens"] != 1200 {
		t.Fatalf("unexpected token counts: %v", usage)
	}
	details, ok := usage["prompt_tokens_details"].(map[string]any)
	if !ok {
		t.Fatalf("prompt_tokens_details missing: %v", usage)
	}
	if details["cached_tokens"] != 400 {
		t.Fatalf("cached_tokens = %v, want 400", details["cached_tokens"])
	}
}

func TestGeminiUsageOmitsCacheDetailsWithoutCacheHit(t *testing.T) {
	cases := []map[string]any{
		{"promptTokenCount": 500, "candidatesTokenCount": 20, "totalTokenCount": 520},
		{"promptTokenCount": 500, "candidatesTokenCount": 20, "totalTokenCount": 520, "cachedContentTokenCount": 0},
	}
	for _, raw := range cases {
		usage := geminiUsage(map[string]any{"usageMetadata": raw})
		if usage == nil {
			t.Fatal("geminiUsage returned nil")
		}
		if _, ok := usage["prompt_tokens_details"]; ok {
			t.Fatalf("prompt_tokens_details present without cache hit: %v", usage)
		}
	}
}

func jsonify(value any) string {
	data, _ := json.Marshal(value)
	return string(data)
}
