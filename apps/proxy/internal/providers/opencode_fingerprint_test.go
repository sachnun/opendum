package providers

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
	"github.com/opendum/opendum/apps/proxy/internal/models"
)

func opencodeToolNames(t *testing.T, payload map[string]any) []string {
	t.Helper()
	tools, _ := payload["tools"].([]any)
	names := []string{}
	for _, raw := range tools {
		tool, _ := raw.(map[string]any)
		fn, _ := tool["function"].(map[string]any)
		name := stringValue(fn["name"])
		if name == "" {
			name = stringValue(tool["name"])
		}
		names = append(names, name)
	}
	return names
}

func mustHaveQuartet(t *testing.T, names []string) {
	t.Helper()
	for _, want := range opencodeFingerprintTools {
		found := false
		for _, name := range names {
			if name == want {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("tools = %#v, missing %q", names, want)
		}
	}
}

func TestOpencodeInjectsFingerprintToolsAndForcesStream(t *testing.T) {
	registry := testModelsRegistry(t)
	model := anyProviderModel(t, registry, "opencode")
	provider := opencodeProvider{registry: registry}
	var payload map[string]any
	client := &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		_ = json.NewDecoder(req.Body).Decode(&payload)
		return jsonTestResponse(http.StatusOK, `{"choices":[{"message":{"content":"ok"}}]}`), nil
	})}

	resp, err := provider.MakeRequest(t.Context(), client, "", appdb.ProviderAccount{}, map[string]any{
		"model":    "opencode/" + model,
		"messages": []any{map[string]any{"role": "user", "content": "hello"}},
	}, false)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if payload["stream"] != true {
		t.Fatalf("upstream stream = %v, want true", payload["stream"])
	}
	mustHaveQuartet(t, opencodeToolNames(t, payload))
}

func TestOpencodePreservesCallerTools(t *testing.T) {
	registry := testModelsRegistry(t)
	model := anyProviderModel(t, registry, "opencode")
	provider := opencodeProvider{registry: registry}
	var payload map[string]any
	client := &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		_ = json.NewDecoder(req.Body).Decode(&payload)
		return jsonTestResponse(http.StatusOK, `{"choices":[{"message":{"content":"ok"}}]}`), nil
	})}

	_, err := provider.MakeRequest(t.Context(), client, "", appdb.ProviderAccount{}, map[string]any{
		"model":    "opencode/" + model,
		"messages": []any{map[string]any{"role": "user", "content": "hello"}},
		"tools": []any{map[string]any{
			"type":     "function",
			"function": map[string]any{"name": "my_tool", "description": "mine", "parameters": map[string]any{"type": "object", "properties": map[string]any{}}},
		}},
	}, true)
	if err != nil {
		t.Fatal(err)
	}
	names := opencodeToolNames(t, payload)
	if len(names) == 0 || names[0] != "my_tool" {
		t.Fatalf("tools = %#v, want my_tool preserved first", names)
	}
	mustHaveQuartet(t, names)
}

func TestOpencodeAggregatesForcedStreamForNonStreamClient(t *testing.T) {
	registry := testModelsRegistry(t)
	model := anyProviderModel(t, registry, "opencode")
	provider := opencodeProvider{registry: registry}
	stream := strings.Join([]string{
		`data: {"choices":[{"delta":{"role":"assistant","content":""}}]}`,
		`data: {"choices":[{"delta":{"content":"Hello"}}]}`,
		`data: {"choices":[{"delta":{"content":" world"}}]}`,
		`data: {"choices":[{"delta":{},"finish_reason":"stop"}]}`,
		`data: [DONE]`,
		"",
	}, "\n\n")
	client := &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"text/event-stream"}}, Body: io.NopCloser(strings.NewReader(stream))}, nil
	})}

	resp, err := provider.MakeRequest(t.Context(), client, "", appdb.ProviderAccount{}, map[string]any{
		"model":    "opencode/" + model,
		"messages": []any{map[string]any{"role": "user", "content": "hello"}},
	}, false)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	var data map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		t.Fatal(err)
	}
	if data["object"] != "chat.completion" {
		t.Fatalf("object = %v", data["object"])
	}
	choices, _ := data["choices"].([]any)
	message, _ := choices[0].(map[string]any)
	content := stringValue(message["message"].(map[string]any)["content"])
	if content != "Hello world" {
		t.Fatalf("content = %q, want %q", content, "Hello world")
	}
}

func TestOpencodeResponsesNativeNonStreamAggregates(t *testing.T) {
	registry := testModelsRegistry(t)
	model := firstProviderConfigModel(t, registry, "opencode", func(cfg models.ProviderModelConfig) bool {
		return customBool(cfg, "responses_api")
	})
	provider := opencodeProvider{registry: registry}
	var payload map[string]any
	stream := strings.Join([]string{
		`event: response.created`,
		`data: {"type":"response.created","response":{"id":"resp_1","object":"response","status":"in_progress","output":[]}}`,
		`event: response.completed`,
		`data: {"type":"response.completed","response":{"id":"resp_1","object":"response","status":"completed","output":[{"type":"message"}]}}`,
		"",
	}, "\n\n")
	client := &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		_ = json.NewDecoder(req.Body).Decode(&payload)
		return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"text/event-stream"}}, Body: io.NopCloser(strings.NewReader(stream))}, nil
	})}

	resp, err := provider.MakeRequest(t.Context(), client, "", appdb.ProviderAccount{}, map[string]any{
		"model":           "opencode/" + model,
		"_responsesInput": []any{map[string]any{"type": "message", "role": "user", "content": []any{map[string]any{"type": "input_text", "text": "hello"}}}},
		"messages":        []any{},
	}, false)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if payload["stream"] != true {
		t.Fatalf("upstream stream = %v, want true", payload["stream"])
	}
	var data map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		t.Fatal(err)
	}
	if data["object"] != "response" || data["id"] != "resp_1" {
		t.Fatalf("data = %#v", data)
	}
}
