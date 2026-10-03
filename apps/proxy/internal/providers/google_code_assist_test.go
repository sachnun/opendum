package providers

import (
	"encoding/json"
	"io"
	"strings"
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

func TestAntigravityRetiredModelNoticeIsDetected(t *testing.T) {
	t.Parallel()
	retired := `{"candidates":[{"content":{"parts":[{"text":"Claude Opus 4.6 is no longer available. Please switch to Claude Opus 5.5."}]}}]}`
	var response map[string]any
	if err := json.Unmarshal([]byte(retired), &response); err != nil {
		t.Fatal(err)
	}
	notice, ok := geminiRetiredModelResponse(response)
	if !ok {
		t.Fatal("retired notice was not detected")
	}
	if !strings.Contains(notice, "Opus 5.5") {
		t.Fatalf("notice = %q, want it to mention the replacement model", notice)
	}

	healthy := `{"candidates":[{"content":{"parts":[{"text":"pong"}]}}],"usageMetadata":{"promptTokenCount":6,"candidatesTokenCount":1,"totalTokenCount":7}}`
	response = map[string]any{}
	if err := json.Unmarshal([]byte(healthy), &response); err != nil {
		t.Fatal(err)
	}
	if _, ok := geminiRetiredModelResponse(response); ok {
		t.Fatal("normal answer must not be treated as a retired notice")
	}
}

func TestAntigravityStreamReportsRetiredModelAsError(t *testing.T) {
	t.Parallel()
	provider := antigravityProvider{}.delegate()
	body := "data: {\"response\": {\"candidates\": [{\"content\": {\"parts\": [{\"text\": \"Claude Sonnet 4.6 is no longer available. Please switch to Claude Sonnet 5.5.\"}]}}]}}\n\n"
	_, err := provider.geminiStreamToOpenAICompletion(t.Context(), strings.NewReader(body), "claude-sonnet-4-6", "sess", toolSchemaMap{})
	if err == nil {
		t.Fatal("retired model must return an error so the account is not marked healthy")
	}
	if !strings.Contains(err.Error(), "retired") {
		t.Fatalf("err = %v, want retired model error", err)
	}
}

func TestAntigravityRetiredNoticeBecomesNotFound(t *testing.T) {
	t.Parallel()
	body := "data: {\"response\": {\"candidates\": [{\"content\": {\"parts\": [{\"text\": \"Claude Opus 4.6 is no longer available. Please switch to Claude Opus 5.5.\"}]}}]}}\n\n"
	reader, notice, retired := peekAntigravityRetiredNotice(strings.NewReader(body))
	if !retired {
		t.Fatal("retired notice must be detected before streaming starts")
	}
	if !strings.Contains(notice, "Opus 5.5") {
		t.Fatalf("notice = %q, want the replacement model", notice)
	}
	if reader != nil {
		t.Fatal("reader must be nil for a retired notice")
	}

	response := antigravityRetiredResponse(nil, notice)
	if response.StatusCode != 404 {
		t.Fatalf("status = %d, want 404 so the account rotates", response.StatusCode)
	}
	payload, _ := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if !strings.Contains(string(payload), "no longer available") {
		t.Fatalf("body = %s, want the upstream notice preserved", payload)
	}
}

func TestAntigravityPeekReplaysNormalStream(t *testing.T) {
	t.Parallel()
	body := "data: {\"response\": {\"candidates\": [{\"content\": {\"parts\": [{\"text\": \"pong\"}]}}]}}\n\n"
	reader, _, retired := peekAntigravityRetiredNotice(strings.NewReader(body))
	if retired {
		t.Fatal("normal stream must not be treated as retired")
	}
	replayed, _ := io.ReadAll(reader)
	_ = reader.Close()
	if string(replayed) != body {
		t.Fatalf("replayed = %q, want the full stream back", replayed)
	}
}
