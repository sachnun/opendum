package providers

import (
	"encoding/json"
	"testing"

	"github.com/opendum/opendum/apps/proxy/internal/models"
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

func TestAntigravityStripsTrailingModelTurn(t *testing.T) {
	registry := testModelsRegistry(t)
	provider := antigravityProvider{registry: registry}.delegate()
	geminiModel := antigravityModelMatching(t, registry, func(cfg models.ProviderModelConfig) bool {
		return !customBool(cfg, "strict_tool_schema")
	})
	claudeModel := antigravityModelMatching(t, registry, func(cfg models.ProviderModelConfig) bool {
		return customBool(cfg, "strict_tool_schema")
	})

	cases := []struct {
		name     string
		model    string
		messages []any
	}{
		{
			name:  "assistant prefill",
			model: geminiModel,
			messages: []any{
				map[string]any{"role": "user", "content": "count to five"},
				map[string]any{"role": "assistant", "content": "1, 2,"},
			},
		},
		{
			name:  "multiple trailing model turns",
			model: geminiModel,
			messages: []any{
				map[string]any{"role": "user", "content": "count to five"},
				map[string]any{"role": "assistant", "content": "1, 2,"},
				map[string]any{"role": "assistant", "content": "3, 4,"},
			},
		},
		{
			name:  "emptied trailing user turn",
			model: geminiModel,
			messages: []any{
				map[string]any{"role": "user", "content": "count to five"},
				map[string]any{"role": "assistant", "content": "1, 2, 3, 4, 5"},
				map[string]any{"role": "user", "content": ""},
			},
		},
		{
			name:  "completed tool round then prefill",
			model: geminiModel,
			messages: []any{
				map[string]any{"role": "user", "content": "list files"},
				map[string]any{"role": "assistant", "content": "", "tool_calls": []any{
					map[string]any{"id": "call_1", "type": "function", "function": map[string]any{"name": "bash", "arguments": `{"command":"ls"}`}},
				}},
				map[string]any{"role": "tool", "tool_call_id": "call_1", "content": "file1.txt"},
				map[string]any{"role": "user", "content": "thanks"},
				map[string]any{"role": "assistant", "content": "you are welcome,"},
			},
		},
		{
			name:  "strict schema assistant prefill",
			model: claudeModel,
			messages: []any{
				map[string]any{"role": "user", "content": "count to five"},
				map[string]any{"role": "assistant", "content": "1, 2,"},
			},
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			payload := openAIToGemini(map[string]any{"model": testCase.model, "messages": testCase.messages})
			provider.transformAntigravityPayload(t.Context(), payload, provider.resolveModel(testCase.model), "sess")
			contents, _ := payload["contents"].([]any)
			if len(contents) == 0 {
				t.Fatalf("contents must not be empty: %s", jsonify(payload))
			}
			last, _ := contents[len(contents)-1].(map[string]any)
			if last["role"] != "user" {
				t.Fatalf("last role = %v, want user: %s", last["role"], jsonify(payload))
			}
		})
	}
}

func TestAntigravityKeepsConversationEndingWithUser(t *testing.T) {
	registry := testModelsRegistry(t)
	provider := antigravityProvider{registry: registry}.delegate()
	model := antigravityModelMatching(t, registry, func(cfg models.ProviderModelConfig) bool {
		return !customBool(cfg, "strict_tool_schema")
	})
	payload := openAIToGemini(map[string]any{
		"model": model,
		"messages": []any{
			map[string]any{"role": "user", "content": "hi"},
			map[string]any{"role": "assistant", "content": "hello"},
			map[string]any{"role": "user", "content": "bye"},
		},
	})
	provider.transformAntigravityPayload(t.Context(), payload, provider.resolveModel(model), "sess")
	contents, _ := payload["contents"].([]any)
	if len(contents) != 3 {
		t.Fatalf("contents = %s", jsonify(payload))
	}
	if ((contents[2]).(map[string]any))["role"] != "user" {
		t.Fatalf("last role = %v, want user", (contents[2]).(map[string]any)["role"])
	}
}

func TestAntigravityKeepsLoneTrailingModelTurn(t *testing.T) {
	registry := testModelsRegistry(t)
	provider := antigravityProvider{registry: registry}.delegate()
	model := antigravityModelMatching(t, registry, func(cfg models.ProviderModelConfig) bool {
		return !customBool(cfg, "strict_tool_schema")
	})
	payload := openAIToGemini(map[string]any{
		"model":    model,
		"messages": []any{map[string]any{"role": "assistant", "content": "lone prefill"}},
	})
	provider.transformAntigravityPayload(t.Context(), payload, provider.resolveModel(model), "sess")
	contents, _ := payload["contents"].([]any)
	if len(contents) != 1 {
		t.Fatalf("contents must never be emptied: %s", jsonify(payload))
	}
	if ((contents[0]).(map[string]any))["role"] != "model" {
		t.Fatalf("role = %v, want model", (contents[0]).(map[string]any)["role"])
	}
}

func antigravityModelMatching(t *testing.T, registry *models.Registry, match func(models.ProviderModelConfig) bool) string {
	t.Helper()
	for _, model := range registry.AllModels() {
		cfg, ok := registry.ProviderModelConfig(model, "antigravity")
		if ok && match(cfg) {
			return model
		}
	}
	t.Skip("no antigravity model matches the required provider config")
	return ""
}

func jsonify(value any) string {
	data, _ := json.Marshal(value)
	return string(data)
}
