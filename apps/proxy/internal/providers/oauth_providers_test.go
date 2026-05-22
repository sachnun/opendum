package providers

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

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

func TestCopilotDropsUnsupportedReasoningEffort(t *testing.T) {
	registry := testModelsRegistry(t)
	provider := copilotProvider{registry: registry}
	for _, tt := range []struct {
		model string
		want  string
	}{
		{model: "copilot/gemini-2.5-pro", want: "gemini-2.5-pro"},
		{model: "copilot/claude-haiku-4-5", want: "claude-haiku-4.5"},
	} {
		t.Run(tt.model, func(t *testing.T) {
			var payload map[string]any
			client := &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
				if err := json.NewDecoder(req.Body).Decode(&payload); err != nil {
					t.Fatal(err)
				}
				return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"choices":[{"message":{"content":"ok"}}]}`))}, nil
			})}

			resp, err := provider.MakeRequest(t.Context(), client, "token", appdb.ProviderAccount{}, map[string]any{
				"model":            tt.model,
				"messages":         []any{map[string]any{"role": "user", "content": "hi"}},
				"reasoning_effort": "low",
				"reasoning":        map[string]any{"effort": "low"},
			}, false)
			if err != nil {
				t.Fatal(err)
			}
			_ = resp.Body.Close()
			if payload["model"] != tt.want {
				t.Fatalf("model = %#v, want %s", payload["model"], tt.want)
			}
			if _, ok := payload["reasoning_effort"]; ok {
				t.Fatalf("unsupported reasoning_effort leaked: %#v", payload)
			}
			if _, ok := payload["reasoning"]; ok {
				t.Fatalf("unsupported reasoning leaked: %#v", payload)
			}
		})
	}
}

func TestNormalizeCopilotTierFromInternalUserPayload(t *testing.T) {
	tests := []struct {
		name    string
		payload map[string]any
		want    string
	}{
		{
			name: "opencode free limited sku",
			payload: map[string]any{
				"access_type_sku": "free_limited_copilot",
				"copilot_plan":    "individual",
			},
			want: "free",
		},
		{
			name: "education sku wins over individual plan",
			payload: map[string]any{
				"access_type_sku": "free_educational_quota",
				"copilot_plan":    "individual",
				"quota_snapshots": map[string]any{
					"premium_interactions": map[string]any{"entitlement": float64(300)},
				},
			},
			want: "student",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := normalizeCopilotTier(tt.payload); got != tt.want {
				t.Fatalf("tier = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestCopilotRefreshCredentialsExchangesStoredGitHubToken(t *testing.T) {
	provider := copilotProvider{}
	expiresAt := time.Now().Add(time.Hour).Unix()
	seen := map[string]bool{}
	client := &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		switch req.URL.String() {
		case copilotInternalTokenEndpoint:
			seen["token"] = true
			if req.Header.Get("Authorization") != "Token ghu_github-token" {
				t.Fatalf("exchange auth = %q", req.Header.Get("Authorization"))
			}
			return jsonTestResponse(http.StatusOK, fmt.Sprintf(`{"token":"copilot-token","expires_at":%d}`, expiresAt)), nil
		case "https://api.github.com/copilot_internal/user":
			seen["tier"] = true
			if req.Header.Get("Authorization") != "Bearer ghu_github-token" {
				t.Fatalf("tier auth = %q", req.Header.Get("Authorization"))
			}
			return jsonTestResponse(http.StatusOK, `{"access_type_sku":"free_limited_copilot"}`), nil
		case copilotUserEndpoint:
			seen["identity"] = true
			if req.Header.Get("Authorization") != "Bearer ghu_github-token" {
				t.Fatalf("identity auth = %q", req.Header.Get("Authorization"))
			}
			return jsonTestResponse(http.StatusOK, `{"login":"octocat"}`), nil
		default:
			t.Fatalf("unexpected request: %s %s", req.Method, req.URL.String())
		}
		return nil, nil
	})}

	refreshed, err := provider.RefreshCredentials(t.Context(), client, " ghu_github-token ", appdb.ProviderAccount{})
	if err != nil {
		t.Fatal(err)
	}
	if refreshed.AccessToken != "copilot-token" || refreshed.StoreAccessToken != "copilot-token" || refreshed.RefreshToken != "ghu_github-token" {
		t.Fatalf("tokens = %#v", refreshed)
	}
	if refreshed.Tier != "free" || refreshed.Email != "octocat" {
		t.Fatalf("metadata = %#v", refreshed)
	}
	if refreshed.ExpiresAt.Unix() != expiresAt {
		t.Fatalf("expiresAt = %v, want %d", refreshed.ExpiresAt, expiresAt)
	}
	for _, key := range []string{"token", "tier", "identity"} {
		if !seen[key] {
			t.Fatalf("missing %s request", key)
		}
	}
}

func TestCopilotRefreshCredentialsKeepsStoredOpencodeTokenRaw(t *testing.T) {
	provider := copilotProvider{}
	seen := map[string]bool{}
	client := &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		switch req.URL.String() {
		case copilotInternalTokenEndpoint:
			t.Fatalf("raw opencode token should not be exchanged")
		case "https://api.github.com/copilot_internal/user":
			seen["tier"] = true
			if req.Header.Get("Authorization") != "Bearer gho_github-token" {
				t.Fatalf("tier auth = %q", req.Header.Get("Authorization"))
			}
			return jsonTestResponse(http.StatusOK, `{"copilot_plan":"pro"}`), nil
		case copilotUserEndpoint:
			seen["identity"] = true
			if req.Header.Get("Authorization") != "Bearer gho_github-token" {
				t.Fatalf("identity auth = %q", req.Header.Get("Authorization"))
			}
			return jsonTestResponse(http.StatusOK, `{"login":"octocat"}`), nil
		default:
			t.Fatalf("unexpected request: %s %s", req.Method, req.URL.String())
		}
		return nil, nil
	})}

	refreshed, err := provider.RefreshCredentials(t.Context(), client, " gho_github-token ", appdb.ProviderAccount{})
	if err != nil {
		t.Fatal(err)
	}
	if refreshed.AccessToken != "gho_github-token" || refreshed.StoreAccessToken != "" || refreshed.RefreshToken != "gho_github-token" {
		t.Fatalf("tokens = %#v", refreshed)
	}
	if refreshed.Tier != "pro" || refreshed.Email != "octocat" {
		t.Fatalf("metadata = %#v", refreshed)
	}
	for _, key := range []string{"tier", "identity"} {
		if !seen[key] {
			t.Fatalf("missing %s request", key)
		}
	}
}

func TestCopilotRefreshCredentialsUsesOAuthRefreshTokenThenExchanges(t *testing.T) {
	provider := copilotProvider{}
	client := &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		switch req.URL.String() {
		case copilotTokenEndpoint:
			if req.Method != http.MethodPost {
				t.Fatalf("refresh method = %s", req.Method)
			}
			var payload map[string]any
			if err := json.NewDecoder(req.Body).Decode(&payload); err != nil {
				t.Fatal(err)
			}
			if payload["refresh_token"] != "ghr_refresh" || payload["grant_type"] != "refresh_token" {
				t.Fatalf("refresh payload = %#v", payload)
			}
			return jsonTestResponse(http.StatusOK, `{"access_token":"ghu_github-token","refresh_token":"ghr_next"}`), nil
		case copilotInternalTokenEndpoint:
			if req.Header.Get("Authorization") != "Token ghu_github-token" {
				t.Fatalf("exchange auth = %q", req.Header.Get("Authorization"))
			}
			return jsonTestResponse(http.StatusOK, `{"token":"copilot-token"}`), nil
		case "https://api.github.com/copilot_internal/user":
			return jsonTestResponse(http.StatusOK, `{"copilot_plan":"pro"}`), nil
		case copilotUserEndpoint:
			return jsonTestResponse(http.StatusOK, `{"email":"user@example.com"}`), nil
		default:
			t.Fatalf("unexpected request: %s %s", req.Method, req.URL.String())
		}
		return nil, nil
	})}

	refreshed, err := provider.RefreshCredentials(t.Context(), client, "ghr_refresh", appdb.ProviderAccount{})
	if err != nil {
		t.Fatal(err)
	}
	if refreshed.AccessToken != "copilot-token" || refreshed.StoreAccessToken != "copilot-token" || refreshed.RefreshToken != "ghr_next" {
		t.Fatalf("tokens = %#v", refreshed)
	}
	if refreshed.Tier != "pro" || refreshed.Email != "user@example.com" {
		t.Fatalf("metadata = %#v", refreshed)
	}
}

func TestCopilotRefreshCredentialsUsesOAuthRefreshTokenThenKeepsOpencodeTokenRaw(t *testing.T) {
	provider := copilotProvider{}
	client := &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		switch req.URL.String() {
		case copilotTokenEndpoint:
			return jsonTestResponse(http.StatusOK, `{"access_token":"gho_github-token","refresh_token":"ghr_next","expires_in":7200}`), nil
		case copilotInternalTokenEndpoint:
			t.Fatalf("refreshed opencode token should not be exchanged")
		case "https://api.github.com/copilot_internal/user":
			return jsonTestResponse(http.StatusOK, `{"copilot_plan":"free"}`), nil
		case copilotUserEndpoint:
			return jsonTestResponse(http.StatusOK, `{"login":"octocat"}`), nil
		default:
			t.Fatalf("unexpected request: %s %s", req.Method, req.URL.String())
		}
		return nil, nil
	})}

	refreshed, err := provider.RefreshCredentials(t.Context(), client, "ghr_refresh", appdb.ProviderAccount{})
	if err != nil {
		t.Fatal(err)
	}
	if refreshed.AccessToken != "gho_github-token" || refreshed.StoreAccessToken != "" || refreshed.RefreshToken != "ghr_next" {
		t.Fatalf("tokens = %#v", refreshed)
	}
	if refreshed.Tier != "free" || refreshed.Email != "octocat" {
		t.Fatalf("metadata = %#v", refreshed)
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

	completion := geminiToOpenAICompletion(map[string]any{"candidates": []any{map[string]any{"content": map[string]any{"parts": []any{map[string]any{"text": "thinking", "thought": true}, map[string]any{"text": "answer"}}}}}}, "unit-test-model", nil)
	message := completion["choices"].([]any)[0].(map[string]any)["message"].(map[string]any)
	if message["content"] != "answer" || message["reasoning_content"] != "thinking" {
		t.Fatalf("message = %#v", message)
	}
}

func TestGeminiCompletionIncludesThoughtPartsWhenReasoningNotRequested(t *testing.T) {
	completion := geminiToOpenAICompletion(map[string]any{"candidates": []any{map[string]any{"content": map[string]any{"parts": []any{map[string]any{"text": "thinking", "thought": true}, map[string]any{"text": "answer"}}}}}}, "unit-test-model", nil)
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

func TestOpenAICompatibleProviderOmitsAuthForAuthlessKiloModel(t *testing.T) {
	registry := testModelsRegistry(t)
	provider := openAICompatibleProvider{name: "kilo_code", baseURL: "https://api.kilo.test/api/gateway", supportedParams: supportedKilo, registry: registry, trimPrefix: "kilo_code/"}
	var authorization string
	client := &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		authorization = req.Header.Get("Authorization")
		return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"choices":[{"message":{"content":"ok"}}]}`))}, nil
	})}

	resp, err := provider.MakeRequest(t.Context(), client, "", appdb.ProviderAccount{}, map[string]any{
		"model":    "kilo_code/laguna-m.1",
		"messages": []any{map[string]any{"role": "user", "content": "hello"}},
	}, false)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if authorization != "" {
		t.Fatalf("Authorization = %q, want empty", authorization)
	}
}

func TestOpenAICompatibleProviderKeepsAuthForKiloAccount(t *testing.T) {
	registry := testModelsRegistry(t)
	provider := openAICompatibleProvider{name: "kilo_code", baseURL: "https://api.kilo.test/api/gateway", supportedParams: supportedKilo, registry: registry, trimPrefix: "kilo_code/"}
	var authorization string
	client := &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		authorization = req.Header.Get("Authorization")
		return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"choices":[{"message":{"content":"ok"}}]}`))}, nil
	})}

	resp, err := provider.MakeRequest(t.Context(), client, "token", appdb.ProviderAccount{}, map[string]any{
		"model":    "kilo_code/laguna-m.1",
		"messages": []any{map[string]any{"role": "user", "content": "hello"}},
	}, false)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if authorization != "Bearer token" {
		t.Fatalf("Authorization = %q, want Bearer token", authorization)
	}
}

func TestOpencodeProviderSendsPublicAuthAndClientHeaders(t *testing.T) {
	provider := opencodeProvider{registry: testModelsRegistry(t)}
	var payload map[string]any
	var headers http.Header
	client := &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		headers = req.Header.Clone()
		if err := json.NewDecoder(req.Body).Decode(&payload); err != nil {
			t.Fatal(err)
		}
		return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"choices":[{"message":{"content":"ok"}}]}`))}, nil
	})}

	resp, err := provider.MakeRequest(t.Context(), client, "", appdb.ProviderAccount{}, map[string]any{
		"model":      "opencode/deepseek-v4-flash",
		"messages":   []any{map[string]any{"role": "user", "content": "hello"}},
		"_sessionId": "sess_1",
		"_realIP":    "203.0.113.10",
	}, false)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if payload["model"] != "deepseek-v4-flash-free" {
		t.Fatalf("model = %#v, want deepseek-v4-flash-free", payload["model"])
	}
	if headers.Get("Authorization") != "Bearer public" {
		t.Fatalf("Authorization = %q, want Bearer public", headers.Get("Authorization"))
	}
	if headers.Get("X-Opencode-Session") != "sess_1" {
		t.Fatalf("X-Opencode-Session = %q, want sess_1", headers.Get("X-Opencode-Session"))
	}
	if headers.Get("X-Real-IP") != "203.0.113.10" {
		t.Fatalf("X-Real-IP = %q, want 203.0.113.10", headers.Get("X-Real-IP"))
	}
	if headers.Get("X-Opencode-Request") == "" || headers.Get("X-Opencode-Client") != opencodeClient || headers.Get("User-Agent") != opencodeUserAgent {
		t.Fatalf("missing opencode headers: %#v", headers)
	}
}

func TestOpenAICompatibleGroqFiltersUnsupportedReasoningEffort(t *testing.T) {
	registry := testModelsRegistry(t)
	provider := openAICompatibleProvider{name: "groq", baseURL: "https://api.groq.test/openai/v1", supportedParams: supportedGroq, registry: registry}
	var payload map[string]any
	client := &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if err := json.NewDecoder(req.Body).Decode(&payload); err != nil {
			t.Fatal(err)
		}
		return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"choices":[{"message":{"content":"ok"}}]}`))}, nil
	})}

	resp, err := provider.MakeRequest(t.Context(), client, "token", appdb.ProviderAccount{}, map[string]any{
		"model":            "llama-4-scout-17b-16e-instruct",
		"messages":         []any{map[string]any{"role": "user", "content": "hi"}},
		"reasoning_effort": "medium",
	}, false)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()

	if payload["model"] != "meta-llama/llama-4-scout-17b-16e-instruct" {
		t.Fatalf("model = %q", payload["model"])
	}
	if _, ok := payload["reasoning_effort"]; ok {
		t.Fatalf("unsupported reasoning_effort leaked to Groq: %#v", payload)
	}
}

func TestOpenAICompatibleGroqKeepsSupportedReasoningEffort(t *testing.T) {
	registry := testModelsRegistry(t)
	provider := openAICompatibleProvider{name: "groq", baseURL: "https://api.groq.test/openai/v1", supportedParams: supportedGroq, registry: registry}
	var payload map[string]any
	client := &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if err := json.NewDecoder(req.Body).Decode(&payload); err != nil {
			t.Fatal(err)
		}
		return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"choices":[{"message":{"content":"ok"}}]}`))}, nil
	})}

	resp, err := provider.MakeRequest(t.Context(), client, "token", appdb.ProviderAccount{}, map[string]any{
		"model":            "gpt-oss-20b",
		"messages":         []any{map[string]any{"role": "user", "content": "hi"}},
		"reasoning_effort": "MEDIUM",
	}, false)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()

	if payload["model"] != "openai/gpt-oss-20b" || payload["reasoning_effort"] != "medium" {
		t.Fatalf("bad Groq reasoning payload: %#v", payload)
	}
}

func TestOpenAICompatibleGroqToolUseFailedBecomesToolCall(t *testing.T) {
	provider := openAICompatibleProvider{name: "groq", baseURL: "https://api.groq.test/openai/v1", supportedParams: supportedGroq}
	client := &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		data, _ := json.Marshal(map[string]any{"error": map[string]any{
			"message":           "Failed to call a function. Please adjust your prompt. See 'failed_generation' for more details.",
			"type":              "invalid_request_error",
			"code":              "tool_use_failed",
			"failed_generation": "<function=get_weather>`{" + `"name":"get_weather","parameters":{"city":"Jakarta","unit":"celsius"}` + "}`</function>\n",
		}})
		body := string(data)
		return &http.Response{StatusCode: http.StatusBadRequest, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(body))}, nil
	})}

	resp, err := provider.MakeRequest(t.Context(), client, "token", appdb.ProviderAccount{}, map[string]any{
		"model":       "llama-3.1-8b-instant",
		"messages":    []any{map[string]any{"role": "user", "content": "weather in Jakarta"}},
		"tools":       []any{map[string]any{"type": "function", "function": map[string]any{"name": "get_weather", "parameters": map[string]any{"type": "object"}}}},
		"tool_choice": "auto",
	}, false)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}

	var completion map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&completion); err != nil {
		t.Fatal(err)
	}
	choice := completion["choices"].([]any)[0].(map[string]any)
	if choice["finish_reason"] != "tool_calls" {
		t.Fatalf("finish_reason = %#v", choice["finish_reason"])
	}
	message := choice["message"].(map[string]any)
	call := message["tool_calls"].([]any)[0].(map[string]any)
	fn := call["function"].(map[string]any)
	if fn["name"] != "get_weather" {
		t.Fatalf("function = %#v", fn)
	}
	var args map[string]any
	if err := json.Unmarshal([]byte(fn["arguments"].(string)), &args); err != nil {
		t.Fatal(err)
	}
	if args["city"] != "Jakarta" || args["unit"] != "celsius" {
		t.Fatalf("arguments = %#v", args)
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

func TestAntigravityGenerationHeadersIncludeCodeAssistMetadata(t *testing.T) {
	provider := antigravityProvider{}.delegate()
	req, err := http.NewRequest(http.MethodPost, "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent", nil)
	if err != nil {
		t.Fatal(err)
	}

	provider.setGoogleGenerationHeaders(req, " token ", true)

	if req.Header.Get("Authorization") != "Bearer token" {
		t.Fatalf("Authorization = %q", req.Header.Get("Authorization"))
	}
	if req.Header.Get("Accept") != "text/event-stream" {
		t.Fatalf("Accept = %q", req.Header.Get("Accept"))
	}
	if !strings.HasPrefix(req.Header.Get("User-Agent"), "antigravity/1.23.2 ") {
		t.Fatalf("User-Agent = %q", req.Header.Get("User-Agent"))
	}
	if req.Header.Get("X-Goog-Api-Client") != "google-cloud-sdk vscode_cloudshelleditor/0.1" {
		t.Fatalf("X-Goog-Api-Client = %q", req.Header.Get("X-Goog-Api-Client"))
	}
	if req.Header.Get("Client-Metadata") != `{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}` {
		t.Fatalf("Client-Metadata = %q", req.Header.Get("Client-Metadata"))
	}
}

func TestAntigravityDiscoveryUsesAntigravityProfile(t *testing.T) {
	provider := antigravityProvider{}.delegate()
	req, err := http.NewRequest(http.MethodPost, "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", nil)
	if err != nil {
		t.Fatal(err)
	}

	provider.setGoogleHeaders(req, "token", false)

	if !strings.HasPrefix(req.Header.Get("User-Agent"), "antigravity/1.23.2 ") {
		t.Fatalf("User-Agent = %q", req.Header.Get("User-Agent"))
	}
	if req.Header.Get("X-Goog-Api-Client") != "google-cloud-sdk vscode_cloudshelleditor/0.1" {
		t.Fatalf("X-Goog-Api-Client = %q", req.Header.Get("X-Goog-Api-Client"))
	}
	if req.Header.Get("Client-Metadata") != `{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}` {
		t.Fatalf("Client-Metadata = %q", req.Header.Get("Client-Metadata"))
	}
}

func TestAntigravityFetchAccountInfoUsesStandardDiscoveryMetadata(t *testing.T) {
	provider := antigravityProvider{}.delegate()
	provider.loadEndpoints = []string{"https://cloudcode-pa.googleapis.com"}

	var loadPayload map[string]any
	client := &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		switch req.URL.Host {
		case "cloudcode-pa.googleapis.com":
			if req.URL.Path != "/v1internal:loadCodeAssist" {
				t.Fatalf("load path = %q", req.URL.Path)
			}
			if !strings.HasPrefix(req.Header.Get("User-Agent"), "antigravity/1.23.2 ") {
				t.Fatalf("discovery User-Agent = %q", req.Header.Get("User-Agent"))
			}
			if err := json.NewDecoder(req.Body).Decode(&loadPayload); err != nil {
				t.Fatal(err)
			}
			return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"cloudaicompanionProject":{"id":"project-1"},"currentTier":{"id":"standard-tier"}}`))}, nil
		case "www.googleapis.com":
			return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"email":"user@example.com"}`))}, nil
		default:
			t.Fatalf("unexpected host = %q", req.URL.Host)
			return nil, nil
		}
	})}

	info := provider.fetchAccountInfo(t.Context(), client, "token")
	if info.projectID != "project-1" || info.tier != "standard-tier" || info.email != "user@example.com" {
		t.Fatalf("account info = %#v", info)
	}
	if _, ok := loadPayload["cloudaicompanionProject"]; ok {
		t.Fatalf("cloudaicompanionProject = %#v", loadPayload["cloudaicompanionProject"])
	}
	metadata := loadPayload["metadata"].(map[string]any)
	if metadata["ideType"] != "IDE_UNSPECIFIED" || metadata["platform"] != "PLATFORM_UNSPECIFIED" || metadata["pluginType"] != "GEMINI" {
		t.Fatalf("metadata = %#v", metadata)
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
		t.Fatal("model should route through Responses API from JSON config")
	}
	if provider.requiresResponsesAPI("unit-test-model") {
		t.Fatal("model without JSON config should not route through Responses API")
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

func TestAntigravityClaudeUpstreamsComeFromRegistry(t *testing.T) {
	registry := testModelsRegistry(t)
	provider := antigravityProvider{registry: registry}.delegate()
	cases := map[string]string{
		"claude-opus-4-6":   "claude-opus-4-6-thinking",
		"claude-sonnet-4-6": "claude-sonnet-4-6",
	}
	for model, want := range cases {
		cfg, ok := registry.ProviderModelConfig(model, "antigravity")
		if !ok {
			t.Fatalf("missing antigravity config for %s", model)
		}
		if cfg.Upstream != "" && cfg.Upstream != want {
			t.Fatalf("registry upstream for %s = %q, want %q", model, cfg.Upstream, want)
		}
		if got := provider.resolveModel(model); got != want {
			t.Fatalf("resolveModel(%s) = %q, want %q", model, got, want)
		}
	}
}

func TestAntigravityWrapCodeAssistPayloadUsesOfficialFields(t *testing.T) {
	registry := testModelsRegistry(t)
	provider := antigravityProvider{registry: registry}.delegate()
	payload := provider.wrapCodeAssistPayload("project-1", "gemini-3-flash", map[string]any{"contents": []any{}})
	if payload["userAgent"] != "antigravity" {
		t.Fatalf("userAgent = %q, want antigravity", payload["userAgent"])
	}
	if payload["requestType"] != "agent" {
		t.Fatalf("requestType = %q, want agent", payload["requestType"])
	}
	if requestID := stringValue(payload["requestId"]); !strings.HasPrefix(requestID, "agent-") {
		t.Fatalf("requestId = %q, want agent-*", requestID)
	}
	if _, exists := payload["enabledCreditTypes"]; exists {
		t.Fatalf("payload should not include enabledCreditTypes: %#v", payload)
	}
	imagePayload := provider.wrapCodeAssistPayload("project-1", "gemini-3.1-flash-image", map[string]any{"contents": []any{}})
	if imagePayload["requestType"] != "agent" {
		t.Fatalf("image requestType = %q, want agent", imagePayload["requestType"])
	}
}

func TestAntigravityGemini3ThinkingBudgetUsesThinkingLevel(t *testing.T) {
	registry := testModelsRegistry(t)
	provider := antigravityProvider{registry: registry}.delegate()
	body := map[string]any{
		"model":           "gemini-3.1-pro-preview",
		"messages":        []any{map[string]any{"role": "user", "content": "hi"}},
		"thinking_budget": 4000,
	}
	model := provider.resolveAntigravityGemini3ModelVariant(provider.resolveModel(stringValue(body["model"])), body)
	if model != "gemini-3.1-pro-low" {
		t.Fatalf("resolved model = %q, want gemini-3.1-pro-low", model)
	}
	payload := openAIToGemini(body)
	provider.transformAntigravityPayload(t.Context(), payload, model, "sess")
	generation := payload["generationConfig"].(map[string]any)
	thinking := generation["thinkingConfig"].(map[string]any)
	if thinking["thinkingLevel"] != "low" || thinking["includeThoughts"] != true {
		t.Fatalf("thinking = %#v", thinking)
	}
	if _, ok := thinking["thinkingBudget"]; ok {
		t.Fatalf("gemini 3 thinking should not include budget: %#v", thinking)
	}
	if _, ok := thinking["thinking_budget"]; ok {
		t.Fatalf("gemini 3 thinking should not include snake_case budget: %#v", thinking)
	}
}

func TestAntigravityGemini3RaisesMaxTokensAboveThinkingBudget(t *testing.T) {
	registry := testModelsRegistry(t)
	provider := antigravityProvider{registry: registry}.delegate()
	body := map[string]any{
		"model":      "gemini-3.1-pro-preview",
		"messages":   []any{map[string]any{"role": "user", "content": "hi"}},
		"max_tokens": 8192,
	}
	model := provider.resolveAntigravityGemini3ModelVariant(provider.resolveModel(stringValue(body["model"])), body)
	if model != "gemini-3.1-pro-high" {
		t.Fatalf("resolved model = %q, want gemini-3.1-pro-high", model)
	}
	payload := openAIToGemini(provider.normalizeBodyForModel(body, model))
	provider.transformAntigravityPayload(t.Context(), payload, model, "sess")
	generation := payload["generationConfig"].(map[string]any)
	if generation["maxOutputTokens"] != 64000 {
		t.Fatalf("maxOutputTokens = %#v, want 64000: %#v", generation["maxOutputTokens"], generation)
	}
	thinking := generation["thinkingConfig"].(map[string]any)
	if thinking["thinkingLevel"] != "high" {
		t.Fatalf("thinking = %#v, want high", thinking)
	}
}

func TestCodexExtractAccountIDFromJWT(t *testing.T) {
	token := "x." + base64.RawURLEncoding.EncodeToString([]byte(`{"https://api.openai.com/auth":{"organizations":[{"id":"org_1","is_default":true}]}}`)) + ".y"
	if got := extractAccountIDFromJWT(token); got != "org_1" {
		t.Fatalf("account id = %q, want org_1", got)
	}
}

func TestCodexExtractTierFromJWT(t *testing.T) {
	token := "x." + base64.RawURLEncoding.EncodeToString([]byte(`{"https://api.openai.com/auth":{"chatgpt_plan_type":"PLUS"}}`)) + ".y"
	if got := extractTierFromJWT(token); got != "plus" {
		t.Fatalf("tier = %q, want plus", got)
	}

	fallbackToken := "x." + base64.RawURLEncoding.EncodeToString([]byte(`{"chatgpt_plan_type":"self_serve_business_usage_based"}`)) + ".y"
	if got := extractTierFromJWT(fallbackToken); got != "self_serve_business_usage_based" {
		t.Fatalf("fallback tier = %q, want self_serve_business_usage_based", got)
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

func TestAntigravityOpenAIToGeminiToolHistoryParity(t *testing.T) {
	payload := openAIToGemini(map[string]any{
		"messages": []any{
			map[string]any{"role": "user", "content": "use tools"},
			map[string]any{"role": "assistant", "content": "thinking", "tool_calls": []any{
				map[string]any{"id": "call_keep", "type": "function", "function": map[string]any{"name": "lookup", "arguments": `{"items":"[1,2]"}`}},
				map[string]any{"id": "call_orphan", "type": "function", "function": map[string]any{"name": "lookup", "arguments": `{}`}},
			}},
			map[string]any{"role": "tool", "tool_call_id": "call_keep", "name": "lookup", "content": "ok"},
			map[string]any{"role": "tool", "tool_call_id": "missing", "name": "lookup", "content": "bad"},
		},
		"stop":             []any{"END"},
		"reasoning_effort": "low",
		"include_thoughts": true,
	})

	contents := payload["contents"].([]any)
	if len(contents) != 4 {
		t.Fatalf("contents len = %d, want 4: %#v", len(contents), contents)
	}
	callParts := contents[2].(map[string]any)["parts"].([]any)
	if len(callParts) != 1 {
		t.Fatalf("call parts = %#v", callParts)
	}
	call := callParts[0].(map[string]any)["functionCall"].(map[string]any)
	if call["id"] != "call_keep" || call["name"] != "lookup" {
		t.Fatalf("functionCall = %#v", call)
	}
	response := contents[3].(map[string]any)["parts"].([]any)[0].(map[string]any)["functionResponse"].(map[string]any)
	if response["id"] != "call_keep" {
		t.Fatalf("functionResponse = %#v", response)
	}
	generation := payload["generationConfig"].(map[string]any)
	if generation["stopSequences"].([]any)[0] != "END" {
		t.Fatalf("generation stop = %#v", generation)
	}
	thinking := generation["thinkingConfig"].(map[string]any)
	if thinking["thinkingBudget"] != 1024 || thinking["include_thoughts"] != true {
		t.Fatalf("thinking = %#v", thinking)
	}
}

func TestAntigravityTransformRemovesCachedContentAndSetsClaudeThinking(t *testing.T) {
	registry := testModelsRegistry(t)
	provider := antigravityProvider{registry: registry}.delegate()
	payload := openAIToGemini(map[string]any{
		"messages":        []any{map[string]any{"role": "user", "content": "hi"}},
		"extra_body":      map[string]any{"cached_content": "cached/123"},
		"tools":           []any{map[string]any{"type": "function", "function": map[string]any{"name": "lookup", "parameters": map[string]any{"$schema": "http://json-schema.org/draft-07/schema#", "properties": map[string]any{}}}}},
		"thinking_budget": 2048,
	})
	provider.transformAntigravityPayload(t.Context(), payload, "claude-opus-4-6-thinking", "sess")
	if _, ok := payload["cachedContent"]; ok {
		t.Fatalf("cachedContent leaked: %#v", payload["cachedContent"])
	}
	if _, ok := payload["cached_content"]; ok {
		t.Fatalf("cached_content leaked: %#v", payload["cached_content"])
	}
	if _, ok := payload["extra_body"]; ok {
		t.Fatalf("extra_body leaked: %#v", payload["extra_body"])
	}
	generation := payload["generationConfig"].(map[string]any)
	thinking := generation["thinkingConfig"].(map[string]any)
	if thinking["thinking_budget"] != 2048 || thinking["include_thoughts"] != true {
		t.Fatalf("claude thinking = %#v", thinking)
	}
	if _, ok := thinking["thinkingBudget"]; ok {
		t.Fatalf("claude thinking should use snake_case only: %#v", thinking)
	}
	decl := payload["tools"].([]any)[0].(map[string]any)["functionDeclarations"].([]any)[0].(map[string]any)
	params := decl["parameters"].(map[string]any)
	if _, ok := params["$schema"]; ok || params["type"] != "object" {
		t.Fatalf("claude params = %#v", params)
	}
}

func TestAntigravitySanitizesUnsupportedToolSchemaFields(t *testing.T) {
	registry := testModelsRegistry(t)
	provider := antigravityProvider{registry: registry}.delegate()
	payload := openAIToGemini(map[string]any{
		"messages": []any{map[string]any{"role": "user", "content": "hi"}},
		"tools": []any{map[string]any{"type": "function", "function": map[string]any{
			"name": "bash",
			"parameters": map[string]any{
				"$schema":              "http://json-schema.org/draft-07/schema#",
				"type":                 "object",
				"additionalProperties": false,
				"properties": map[string]any{
					"timeout": map[string]any{"type": "integer", "exclusiveMinimum": 0, "maximum": 120000, "default": 120000},
					"options": map[string]any{"type": "object", "properties": map[string]any{
						"retries": map[string]any{"type": []any{"integer", "null"}, "minimum": 1, "exclusiveMaximum": 5},
					}},
					"mode": map[string]any{"anyOf": []any{
						map[string]any{"const": "fast"},
						map[string]any{"const": "safe"},
					}},
				},
				"required": []any{"timeout", "missing"},
			},
		}}},
	})

	provider.transformAntigravityPayload(t.Context(), payload, "claude-opus-4-6-thinking", "sess")

	decl := payload["tools"].([]any)[0].(map[string]any)["functionDeclarations"].([]any)[0].(map[string]any)
	params := decl["parameters"].(map[string]any)
	if _, ok := params["$schema"]; ok {
		t.Fatalf("$schema leaked: %#v", params)
	}
	if _, ok := params["additionalProperties"]; ok {
		t.Fatalf("additionalProperties leaked: %#v", params)
	}
	if required := params["required"].([]any); len(required) != 1 || required[0] != "timeout" {
		t.Fatalf("required not filtered: %#v", params["required"])
	}
	props := params["properties"].(map[string]any)
	timeout := props["timeout"].(map[string]any)
	if _, ok := timeout["exclusiveMinimum"]; ok || timeout["maximum"] != nil || timeout["default"] != nil {
		t.Fatalf("timeout schema not sanitized: %#v", timeout)
	}
	options := props["options"].(map[string]any)
	if required := options["required"].([]any); len(required) != 0 {
		t.Fatalf("nested required should default to empty: %#v", options)
	}
	retries := options["properties"].(map[string]any)["retries"].(map[string]any)
	if _, ok := retries["exclusiveMaximum"]; ok || retries["minimum"] != nil || retries["nullable"] != nil {
		t.Fatalf("nested schema not sanitized: %#v", retries)
	}
	mode := props["mode"].(map[string]any)
	if mode["type"] != "string" || !reflect.DeepEqual(mode["enum"], []any{"fast", "safe"}) {
		t.Fatalf("union enum not flattened: %#v", mode)
	}
}

func TestAntigravitySanitizesWebFetchLikeDefaultSchema(t *testing.T) {
	registry := testModelsRegistry(t)
	provider := antigravityProvider{registry: registry}.delegate()
	payload := openAIToGemini(map[string]any{
		"messages": []any{map[string]any{"role": "user", "content": "hi"}},
		"tools": []any{map[string]any{"type": "function", "function": map[string]any{
			"name": "webfetch",
			"parameters": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"url":     map[string]any{"type": "string", "description": "The URL to fetch content from", "format": "uri", "minLength": 1},
					"format":  map[string]any{"type": "string", "enum": []any{"text", "markdown", "html"}, "default": "markdown"},
					"timeout": map[string]any{"type": "number", "maximum": 120},
				},
				"required": []any{"url", "format"},
			},
		}}},
	})

	provider.transformAntigravityPayload(t.Context(), payload, "claude-opus-4-6-thinking", "sess")

	decl := payload["tools"].([]any)[0].(map[string]any)["functionDeclarations"].([]any)[0].(map[string]any)
	props := decl["parameters"].(map[string]any)["properties"].(map[string]any)
	url := props["url"].(map[string]any)
	if url["format"] != nil || url["minLength"] != nil {
		t.Fatalf("url schema not sanitized: %#v", url)
	}
	format := props["format"].(map[string]any)
	if format["default"] != nil || !reflect.DeepEqual(format["enum"], []any{"text", "markdown", "html"}) {
		t.Fatalf("format schema not sanitized: %#v", format)
	}
	timeout := props["timeout"].(map[string]any)
	if timeout["maximum"] != nil {
		t.Fatalf("timeout schema not sanitized: %#v", timeout)
	}
}

func TestAntigravityV1EndpointOrderAndDefaults(t *testing.T) {
	provider := antigravityProvider{}.delegate()
	wantEndpoints := []string{"https://daily-cloudcode-pa.googleapis.com", "https://autopush-cloudcode-pa.sandbox.googleapis.com", "https://cloudcode-pa.googleapis.com"}
	if strings.Join(provider.endpoints, ",") != strings.Join(wantEndpoints, ",") {
		t.Fatalf("endpoints = %#v, want %#v", provider.endpoints, wantEndpoints)
	}
	if provider.defaultProject != "rising-fact-p41fc" {
		t.Fatalf("defaultProject = %q", provider.defaultProject)
	}
}

func TestAntigravityFetchAccountInfoOnboardsWithAllowedTier(t *testing.T) {
	provider := antigravityProvider{}.delegate()
	provider.loadEndpoints = []string{"https://cloudcode-pa.googleapis.com"}
	provider.onboardEndpoints = []string{"https://daily-cloudcode-pa.googleapis.com"}
	var onboardPayload map[string]any
	client := &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		switch req.URL.Host {
		case "cloudcode-pa.googleapis.com":
			return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"allowedTiers":[{"id":"legacy-tier","isDefault":true}]}`))}, nil
		case "daily-cloudcode-pa.googleapis.com":
			if err := json.NewDecoder(req.Body).Decode(&onboardPayload); err != nil {
				t.Fatal(err)
			}
			return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"done":true,"response":{"cloudaicompanionProject":{"id":"onboard-project"}}}`))}, nil
		case "www.googleapis.com":
			return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"email":"new@example.com"}`))}, nil
		default:
			t.Fatalf("unexpected host = %q", req.URL.Host)
			return nil, nil
		}
	})}

	info := provider.fetchAccountInfo(t.Context(), client, "token")
	if info.projectID != "onboard-project" || info.tier != "legacy-tier" || info.email != "new@example.com" {
		t.Fatalf("account info = %#v", info)
	}
	if onboardPayload["tierId"] != "legacy-tier" {
		t.Fatalf("onboard payload = %#v", onboardPayload)
	}
	if _, ok := onboardPayload["cloudaicompanionProject"]; ok {
		t.Fatalf("onboard payload should omit project: %#v", onboardPayload)
	}
}

func TestAntigravityMakeRequestUsesDefaultProjectWithoutDiscovery(t *testing.T) {
	registry := testModelsRegistry(t)
	provider := antigravityProvider{registry: registry}.delegate()
	var payload map[string]any
	client := &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if req.URL.Host != "daily-cloudcode-pa.googleapis.com" {
			t.Fatalf("unexpected discovery/fallback host = %q", req.URL.Host)
		}
		if err := json.NewDecoder(req.Body).Decode(&payload); err != nil {
			t.Fatal(err)
		}
		return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}`))}, nil
	})}

	resp, err := provider.MakeRequest(t.Context(), client, "token", appdb.ProviderAccount{}, map[string]any{
		"model":    "antigravity/gemini-3-flash-preview",
		"messages": []any{map[string]any{"role": "user", "content": "hi"}},
	}, false)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if payload["project"] != "rising-fact-p41fc" {
		t.Fatalf("project = %#v", payload["project"])
	}
}

func TestAntigravityDropsUnsupportedLogitBias(t *testing.T) {
	registry := testModelsRegistry(t)
	provider := antigravityProvider{registry: registry}.delegate()
	var payload map[string]any
	client := &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if err := json.NewDecoder(req.Body).Decode(&payload); err != nil {
			t.Fatal(err)
		}
		return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}`))}, nil
	})}

	resp, err := provider.MakeRequest(t.Context(), client, "token", appdb.ProviderAccount{}, map[string]any{
		"model":      "antigravity/gemini-3.1-pro-preview",
		"messages":   []any{map[string]any{"role": "user", "content": "hi"}},
		"logit_bias": map[string]any{"12429": -50},
	}, false)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	request := payload["request"].(map[string]any)
	if _, ok := request["logit_bias"]; ok {
		t.Fatalf("logit_bias leaked to request: %#v", request)
	}
	if generation, ok := request["generationConfig"].(map[string]any); ok {
		if _, ok := generation["logitBias"]; ok {
			t.Fatalf("logitBias leaked to generationConfig: %#v", generation)
		}
	}
}

func TestAntigravityResponseNormalizesToolArgsFinishAndUsage(t *testing.T) {
	schemas := toolSchemaMap{"lookup": map[string]schemaInfo{"items": {typ: "array"}, "query": {typ: "string"}}}
	response := map[string]any{
		"candidates": []any{map[string]any{
			"finishReason": "MAX_TOKENS",
			"content":      map[string]any{"parts": []any{map[string]any{"functionCall": map[string]any{"name": "lookup", "id": "call_1", "args": map[string]any{"items": "[1,2]", "query": `line\nbreak`}}}}},
		}},
		"usageMetadata": map[string]any{"promptTokenCount": 3, "candidatesTokenCount": 4, "totalTokenCount": 7},
	}
	completion := geminiToOpenAICompletion(response, "gemini-test", schemas)
	choice := completion["choices"].([]any)[0].(map[string]any)
	if choice["finish_reason"] != "tool_calls" {
		t.Fatalf("finish_reason = %#v", choice["finish_reason"])
	}
	message := choice["message"].(map[string]any)
	call := message["tool_calls"].([]any)[0].(map[string]any)
	args := call["function"].(map[string]any)["arguments"].(string)
	var parsedArgs map[string]any
	if err := json.Unmarshal([]byte(args), &parsedArgs); err != nil {
		t.Fatalf("arguments did not parse: %s", args)
	}
	items := parsedArgs["items"].([]any)
	if len(items) != 2 || parsedArgs["query"] != "line\nbreak" {
		t.Fatalf("arguments = %#v", parsedArgs)
	}
	usage := completion["usage"].(map[string]any)
	if usage["prompt_tokens"] != 3 || usage["completion_tokens"] != 4 || usage["total_tokens"] != 7 {
		t.Fatalf("usage = %#v", usage)
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

func jsonTestResponse(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(body))}
}

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
