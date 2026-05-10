package providers

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
	"github.com/opendum/opendum/apps/proxy/internal/models"
)

func TestCodexBuildPayloadConvertsChatToResponses(t *testing.T) {
	provider := codexProvider{}
	model := "unit-test-model"
	payload := provider.buildPayload(map[string]any{
		"model":             "codex/" + model,
		"messages":          []any{map[string]any{"role": "system", "content": "be terse"}, map[string]any{"role": "user", "content": "hi"}},
		"tools":             []any{map[string]any{"type": "function", "function": map[string]any{"name": "lookup", "parameters": map[string]any{"type": "object"}}}},
		"reasoning_effort":  "medium",
		"_includeReasoning": true,
		"_sessionId":        "sess_1",
	}, model, true)

	if payload["model"] != model || payload["store"] != false || payload["stream"] != true {
		t.Fatalf("bad codex payload base: %#v", payload)
	}
	if payload["instructions"] != "be terse" {
		t.Fatalf("instructions = %q, want be terse", payload["instructions"])
	}
	input := payload["input"].([]any)
	if len(input) != 2 || input[0].(map[string]any)["role"] != "developer" {
		t.Fatalf("input = %#v", input)
	}
	reasoning := payload["reasoning"].(map[string]any)
	if reasoning["effort"] != "medium" || reasoning["summary"] != "auto" {
		t.Fatalf("reasoning = %#v", reasoning)
	}
	if payload["prompt_cache_key"] != "sess_1" {
		t.Fatalf("session payload missing: %#v", payload)
	}
}

func TestCopilotResponsesPayload(t *testing.T) {
	provider := copilotProvider{}
	model := "unit-test-model"
	payload := provider.buildResponsesPayload(map[string]any{
		"messages":         []any{map[string]any{"role": "developer", "content": "rules"}, map[string]any{"role": "user", "content": "hi"}},
		"max_tokens":       42,
		"reasoning_effort": "high",
	}, model, true)

	if payload["model"] != model || payload["stream"] != true || payload["max_output_tokens"] != 42 {
		t.Fatalf("bad copilot responses payload: %#v", payload)
	}
	if payload["instructions"] != "rules" {
		t.Fatalf("instructions = %q, want rules", payload["instructions"])
	}
	reasoning := payload["reasoning"].(map[string]any)
	if reasoning["effort"] != "high" {
		t.Fatalf("reasoning = %#v", reasoning)
	}
}

func TestGoogleCodeAssistConversion(t *testing.T) {
	payload := openAIToGemini(map[string]any{
		"messages":    []any{map[string]any{"role": "system", "content": "policy"}, map[string]any{"role": "user", "content": "hello"}},
		"temperature": 0.3,
		"max_tokens":  64,
	})
	if payload["systemInstruction"] == nil {
		t.Fatalf("systemInstruction missing: %#v", payload)
	}
	contents := payload["contents"].([]any)
	if len(contents) != 1 || contents[0].(map[string]any)["role"] != "user" {
		t.Fatalf("contents = %#v", contents)
	}
	generation := payload["generationConfig"].(map[string]any)
	if generation["temperature"] != 0.3 || generation["maxOutputTokens"] != 64 {
		t.Fatalf("generation = %#v", generation)
	}

	completion := geminiToOpenAICompletion(map[string]any{"candidates": []any{map[string]any{"content": map[string]any{"parts": []any{map[string]any{"text": "thinking", "thought": true}, map[string]any{"text": "answer"}}}}}}, "unit-test-model", true)
	message := completion["choices"].([]any)[0].(map[string]any)["message"].(map[string]any)
	if message["content"] != "answer" || message["reasoning_content"] != "thinking" {
		t.Fatalf("message = %#v", message)
	}
}

func TestOpenAICompatibleProviderConvertsOllamaCloudImageURL(t *testing.T) {
	var payload map[string]any
	client := imageCaptureClient(t, &payload)
	provider := openAICompatibleProvider{name: "ollama_cloud", baseURL: "https://ollama.com/v1", supportedParams: supportedOllama, registry: testModelsRegistry(t)}

	resp, err := provider.MakeRequest(t.Context(), client, "token", appdb.ProviderAccount{}, imageURLBody("ollama_cloud"), false)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	assertChatImageDataURI(t, payload)
}

func TestOpenAICompatibleProviderRoutesKiloResponsesModel(t *testing.T) {
	registry := testModelsRegistry(t)
	provider := openAICompatibleProvider{name: "kilo_code", baseURL: "https://api.kilo.test/api/gateway", supportedParams: supportedKilo, registry: registry, trimPrefix: "kilo_code/"}
	var path string
	var payload map[string]any
	client := &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		path = req.URL.Path
		if err := json.NewDecoder(req.Body).Decode(&payload); err != nil {
			t.Fatal(err)
		}
		return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"ok"}]}],"usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}`))}, nil
	})}

	resp, err := provider.MakeRequest(t.Context(), client, "token", appdb.ProviderAccount{}, map[string]any{
		"model":      "kilo_code/grok-code-fast-1",
		"messages":   []any{map[string]any{"role": "user", "content": "hello"}},
		"max_tokens": 42,
	}, false)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if path != "/api/gateway/responses" {
		t.Fatalf("upstream path = %q, want /api/gateway/responses", path)
	}
	if payload["model"] != "x-ai/grok-code-fast-1:optimized:free" || payload["max_output_tokens"] != float64(42) && payload["max_output_tokens"] != 42 {
		t.Fatalf("bad responses payload: %#v", payload)
	}
	if _, ok := payload["messages"]; ok {
		t.Fatalf("responses payload leaked messages: %#v", payload)
	}
	input := payload["input"].([]any)
	if len(input) != 1 || input[0].(map[string]any)["type"] != "message" {
		t.Fatalf("responses input = %#v", input)
	}

	var completion map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&completion); err != nil {
		t.Fatal(err)
	}
	choice := completion["choices"].([]any)[0].(map[string]any)
	message := choice["message"].(map[string]any)
	if completion["object"] != "chat.completion" || message["content"] != "ok" {
		t.Fatalf("converted completion = %#v", completion)
	}
}

func TestWorkersAIProviderConvertsImageURL(t *testing.T) {
	accountID := "acct_123"
	var payload map[string]any
	client := imageCaptureClient(t, &payload)
	provider := workersAIProvider{registry: testModelsRegistry(t)}

	resp, err := provider.MakeRequest(t.Context(), client, "token", appdb.ProviderAccount{AccountID: &accountID}, imageURLBody("workers_ai"), false)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	assertChatImageDataURI(t, payload)
}

func TestGoogleCodeAssistConvertsImageURLToInlineData(t *testing.T) {
	projectID := "project_123"
	var payload map[string]any
	client := imageCaptureClient(t, &payload)
	provider := googleCodeAssistProvider{name: "gemini_cli", endpoint: "https://cloudcode-pa.googleapis.com", registry: testModelsRegistry(t)}

	resp, err := provider.MakeRequest(t.Context(), client, "token", appdb.ProviderAccount{ProjectID: &projectID}, imageURLBody("gemini_cli"), false)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	request := payload["request"].(map[string]any)
	contents := request["contents"].([]any)
	parts := contents[0].(map[string]any)["parts"].([]any)
	inlineData := parts[1].(map[string]any)["inlineData"].(map[string]any)
	if inlineData["mimeType"] != "image/png" || inlineData["data"] == "" {
		t.Fatalf("inlineData = %#v", inlineData)
	}
}

func TestCopilotSystemToolInjection(t *testing.T) {
	messages := injectCopilotChatSystemTool([]any{map[string]any{"role": "user", "content": "hello"}})
	if len(messages) != 3 {
		t.Fatalf("messages len = %d, want 3", len(messages))
	}
	assistant := messages[0].(map[string]any)
	if assistant["role"] != "assistant" {
		t.Fatalf("first message = %#v", assistant)
	}
	toolCalls := assistant["tool_calls"].([]any)
	fn := toolCalls[0].(map[string]any)["function"].(map[string]any)
	if fn["name"] != "get_context" {
		t.Fatalf("tool call = %#v", fn)
	}
}

func TestResponsesInputToChatMessages(t *testing.T) {
	messages := responsesInputToChatMessages([]any{
		map[string]any{"type": "function_call", "call_id": "fc_lookup", "name": "lookup", "arguments": `{"x":1}`},
		map[string]any{"type": "function_call_output", "call_id": "fc_lookup", "output": "ok"},
		map[string]any{"type": "message", "role": "developer", "content": "rules"},
	}, "")
	if len(messages) != 3 {
		t.Fatalf("messages len = %d, want 3: %#v", len(messages), messages)
	}
	assistant := messages[0].(map[string]any)
	call := assistant["tool_calls"].([]any)[0].(map[string]any)
	if call["id"] != "call_lookup" {
		t.Fatalf("call id = %q, want call_lookup", call["id"])
	}
	if messages[2].(map[string]any)["role"] != "system" {
		t.Fatalf("developer role not converted: %#v", messages[2])
	}
}

func TestAntigravitySystemInstructionAndThinking(t *testing.T) {
	registry := testModelsRegistry(t)
	provider := antigravityProvider{registry: registry}.delegate()
	systemModel := firstProviderConfigModel(t, registry, "antigravity", func(cfg models.ProviderModelConfig) bool { return customBool(cfg, "system_instruction") })
	thinkingModel := firstProviderConfigModel(t, registry, "antigravity", func(cfg models.ProviderModelConfig) bool { return len(customMap(cfg, "thinking_levels")) > 0 })
	payload := openAIToGemini(map[string]any{"messages": []any{map[string]any{"role": "system", "content": "user system"}, map[string]any{"role": "user", "content": "hi"}}})
	provider.applyAntigravitySystemInstruction(payload, systemModel)
	system := payload["systemInstruction"].(map[string]any)
	parts := system["parts"].([]any)
	if !strings.Contains(parts[0].(map[string]any)["text"].(string), "Antigravity") {
		t.Fatalf("antigravity instruction missing: %#v", parts[0])
	}
	provider.applyThinkingConfig(payload, thinkingModel, "medium", 0)
	generation := payload["generationConfig"].(map[string]any)
	thinking := generation["thinkingConfig"].(map[string]any)
	cfg, _ := registry.ProviderModelConfig(thinkingModel, "antigravity")
	levels := customMap(cfg, "thinking_levels")
	if thinking["thinkingLevel"] != levels["medium"] || thinking["includeThoughts"] != true {
		t.Fatalf("thinking config = %#v", thinking)
	}
}

func TestCodexModelGuardUsesRegistryWhenPresent(t *testing.T) {
	provider := codexProvider{}
	if !provider.isModelAllowed("anything-without-registry") {
		t.Fatal("nil registry should allow caller-validated model")
	}
}

func TestProviderCustomConfigDrivesCopilotResponsesAPI(t *testing.T) {
	registry := testModelsRegistry(t)
	provider := copilotProvider{registry: registry}
	responsesModel := firstProviderConfigModel(t, registry, "copilot", func(cfg models.ProviderModelConfig) bool { return customBool(cfg, "responses_api") })
	if !provider.requiresResponsesAPI(responsesModel) {
		t.Fatal("model should route through Responses API from TOML config")
	}
	if provider.requiresResponsesAPI("unit-test-model") {
		t.Fatal("model without TOML config should not route through Responses API")
	}
}

func TestProviderCustomUpstreamDrivesAntigravityModelResolution(t *testing.T) {
	registry := testModelsRegistry(t)
	provider := antigravityProvider{registry: registry}.delegate()
	model := firstProviderConfigModel(t, registry, "antigravity", func(cfg models.ProviderModelConfig) bool {
		return cfg.Upstream != ""
	})
	cfg, _ := registry.ProviderModelConfig(model, "antigravity")
	if got := provider.resolveModel(model); got != cfg.Upstream {
		t.Fatalf("resolveModel = %q, want %q", got, cfg.Upstream)
	}
}

func TestCodexExtractAccountIDFromJWT(t *testing.T) {
	token := "x." + base64.RawURLEncoding.EncodeToString([]byte(`{"https://api.openai.com/auth":{"organizations":[{"id":"org_1","is_default":true}]}}`)) + ".y"
	if got := extractAccountIDFromJWT(token); got != "org_1" {
		t.Fatalf("account id = %q, want org_1", got)
	}
}

func TestAntigravityTransformsToolPayload(t *testing.T) {
	registry := testModelsRegistry(t)
	provider := antigravityProvider{registry: registry}.delegate()
	model := firstProviderConfigModel(t, registry, "antigravity", func(cfg models.ProviderModelConfig) bool {
		return customBool(cfg, "system_instruction") && !customBool(cfg, "strict_tool_schema")
	})
	payload := openAIToGemini(map[string]any{
		"messages": []any{map[string]any{"role": "user", "content": "hi"}},
		"tools":    []any{map[string]any{"type": "function", "function": map[string]any{"name": "1bad", "description": "lookup", "parameters": map[string]any{"type": "object", "properties": map[string]any{"query": map[string]any{"type": "string"}}, "required": []any{"query"}}}}},
	})
	provider.transformAntigravityPayload(t.Context(), payload, model, "sess")
	toolConfig := payload["toolConfig"].(map[string]any)
	calling := toolConfig["functionCallingConfig"].(map[string]any)
	if calling["mode"] != "VALIDATED" {
		t.Fatalf("tool mode = %#v", calling)
	}
	decl := payload["tools"].([]any)[0].(map[string]any)["functionDeclarations"].([]any)[0].(map[string]any)
	if decl["name"] != "t_1bad" || !strings.Contains(decl["description"].(string), "STRICT PARAMETERS") {
		t.Fatalf("decl = %#v", decl)
	}
}

func TestAntigravityScrubsToolTranscriptArtifacts(t *testing.T) {
	text := "ok\nTool: read\n```\nthought: hidden\n```\ndone"
	cleaned := scrubToolTranscriptArtifacts(text)
	if strings.Contains(cleaned, "Tool:") || strings.Contains(cleaned, "thought:") {
		t.Fatalf("artifact not scrubbed: %q", cleaned)
	}
}

func TestAntigravityInjectsGeminiToolInstruction(t *testing.T) {
	payload := map[string]any{"tools": []any{map[string]any{"functionDeclarations": []any{map[string]any{"name": "lookup"}}}}}
	injectGeminiToolInstruction(payload)
	system := payload["systemInstruction"].(map[string]any)
	text := system["parts"].([]any)[0].(map[string]any)["text"].(string)
	if !strings.Contains(text, "CRITICAL_TOOL_USAGE_INSTRUCTIONS") {
		t.Fatalf("tool instruction missing: %q", text)
	}
}

func TestUnsafeImageURLRejected(t *testing.T) {
	if isSafeExternalURL("http://127.0.0.1/image.png") {
		t.Fatal("loopback URL should be rejected")
	}
}

func imageURLBody(provider string) map[string]any {
	return map[string]any{
		"model": provider + "/unit-test-model",
		"messages": []any{map[string]any{"role": "user", "content": []any{
			map[string]any{"type": "text", "text": "describe"},
			map[string]any{"type": "image_url", "image_url": map[string]any{"url": "https://8.8.8.8/image.png"}},
		}}},
	}
}

func imageCaptureClient(t *testing.T, captured *map[string]any) *http.Client {
	t.Helper()
	return &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if req.URL.Host == "8.8.8.8" {
			return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"image/png"}}, Body: io.NopCloser(strings.NewReader("png"))}, nil
		}
		if err := json.NewDecoder(req.Body).Decode(captured); err != nil {
			t.Fatal(err)
		}
		return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}`))}, nil
	})}
}

func assertChatImageDataURI(t *testing.T, payload map[string]any) {
	t.Helper()
	messages := payload["messages"].([]any)
	content := messages[0].(map[string]any)["content"].([]any)
	imageURL := content[1].(map[string]any)["image_url"].(map[string]any)
	if got := stringValue(imageURL["url"]); !strings.HasPrefix(got, "data:image/png;base64,") {
		t.Fatalf("image url = %q", got)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

func testModelsRegistry(t *testing.T) *models.Registry {
	t.Helper()
	registry, err := models.Load(filepath.Join("..", "..", "..", "..", "models"))
	if err != nil {
		t.Fatal(err)
	}
	return registry
}

func firstProviderConfigModel(t *testing.T, registry *models.Registry, provider string, match func(models.ProviderModelConfig) bool) string {
	t.Helper()
	for _, model := range registry.AllModels() {
		cfg, ok := registry.ProviderModelConfig(model, provider)
		if ok && match(cfg) {
			return model
		}
	}
	t.Fatalf("missing provider config for %s", provider)
	return ""
}

func customBool(cfg models.ProviderModelConfig, key string) bool {
	value, _ := cfg.Custom[key].(bool)
	return value
}

func customMap(cfg models.ProviderModelConfig, key string) map[string]any {
	value, _ := cfg.Custom[key].(map[string]any)
	return value
}
