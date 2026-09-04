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

func jsonify(value any) string {
	data, _ := json.Marshal(value)
	return string(data)
}
