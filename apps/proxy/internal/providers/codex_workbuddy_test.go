package providers

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
	"github.com/opendum/opendum/apps/proxy/internal/models"
)

func loadProviderRegistry(t *testing.T, files map[string]map[string]any) *models.Registry {
	t.Helper()
	dir := t.TempDir()
	for name, body := range files {
		data, err := json.MarshalIndent(body, "", "  ")
		if err != nil {
			t.Fatalf("marshal %s: %v", name, err)
		}
		if err := os.WriteFile(filepath.Join(dir, name+".json"), data, 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	registry, err := models.Load(dir)
	if err != nil {
		t.Fatalf("load registry: %v", err)
	}
	return registry
}

func TestCodexMakeRequestBuildsResponsesCall(t *testing.T) {
	t.Parallel()
	var rec recordedRequest
	sse := "data: {\"type\":\"response.output_text.delta\",\"delta\":\"Hi\"}\n\n" +
		"data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":2}}}\n\n"
	client := recordingClient(http.StatusOK, sse, &rec)
	accountID := "ws_1"

	resp, err := codexProvider{}.MakeRequest(context.Background(), client, "tok", appdb.ProviderAccount{ID: "acc", AccountID: &accountID}, map[string]any{"model": "gpt-5.5", "messages": []any{map[string]any{"role": "user", "content": "hi"}}}, false)
	if err != nil {
		t.Fatalf("MakeRequest: %v", err)
	}
	if rec.req.URL.String() != codexAPIBaseURL {
		t.Fatalf("url = %q, want %q", rec.req.URL.String(), codexAPIBaseURL)
	}
	if got := rec.req.Header.Get("ChatGPT-Account-Id"); got != "ws_1" {
		t.Fatalf("account header = %q, want ws_1", got)
	}
	if got := rec.req.Header.Get("originator"); got != codexOriginator {
		t.Fatalf("originator = %q", got)
	}
	if got := rec.req.Header.Get("Accept"); got != "text/event-stream" {
		t.Fatalf("Accept = %q", got)
	}
	var payload map[string]any
	_ = json.Unmarshal(rec.body, &payload)
	if payload["model"] != "gpt-5.5" {
		t.Fatalf("payload model = %v", payload["model"])
	}
	decoded := map[string]any{}
	if err := json.NewDecoder(resp.Body).Decode(&decoded); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if decoded["object"] != "chat.completion" {
		t.Fatalf("object = %v, want chat.completion", decoded["object"])
	}
}

func TestCodexMakeRequestRejectsUnsupportedModel(t *testing.T) {
	t.Parallel()
	registry := loadProviderRegistry(t, map[string]map[string]any{
		"mock-codex-model": {"providers": []string{"codex"}, "providerConfig": map[string]any{"codex": map[string]any{"upstream": "gpt-5.5"}}},
	})
	var rec recordedRequest
	client := recordingClient(http.StatusOK, "{}", &rec)

	resp, err := codexProvider{registry: registry}.MakeRequest(context.Background(), client, "tok", appdb.ProviderAccount{ID: "acc"}, map[string]any{"model": "unlisted-model"}, false)
	if err != nil {
		t.Fatalf("MakeRequest: %v", err)
	}
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
	var payload struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	body, _ := io.ReadAll(resp.Body)
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if payload.Error.Code != "unsupported_codex_chatgpt_model" {
		t.Fatalf("code = %q, want unsupported_codex_chatgpt_model", payload.Error.Code)
	}
	if rec.req != nil {
		t.Fatal("upstream should not be called for an unsupported model")
	}
}

func TestCodexRefreshCredentials(t *testing.T) {
	t.Parallel()
	t.Run("success", func(t *testing.T) {
		t.Parallel()
		var rec recordedRequest
		client := recordingClient(http.StatusOK, `{"access_token":"at","refresh_token":"rt","expires_in":1800}`, &rec)
		creds, err := codexProvider{}.RefreshCredentials(context.Background(), client, "old", appdb.ProviderAccount{})
		if err != nil {
			t.Fatalf("RefreshCredentials: %v", err)
		}
		if creds.AccessToken != "at" || creds.RefreshToken != "rt" {
			t.Fatalf("creds = %+v", creds)
		}
		if until := time.Until(creds.ExpiresAt); until < 29*time.Minute || until > 30*time.Minute {
			t.Fatalf("expiry = %v, want about 30m", until)
		}
		if got := rec.req.Header.Get("Content-Type"); got != "application/x-www-form-urlencoded" {
			t.Fatalf("Content-Type = %q", got)
		}
	})

	t.Run("defaults refresh token and expiry", func(t *testing.T) {
		t.Parallel()
		var rec recordedRequest
		client := recordingClient(http.StatusOK, `{"access_token":"at"}`, &rec)
		creds, err := codexProvider{}.RefreshCredentials(context.Background(), client, "old", appdb.ProviderAccount{})
		if err != nil {
			t.Fatalf("RefreshCredentials: %v", err)
		}
		if creds.RefreshToken != "old" {
			t.Fatalf("refresh token = %q, want old", creds.RefreshToken)
		}
	})

	t.Run("http error", func(t *testing.T) {
		t.Parallel()
		var rec recordedRequest
		client := recordingClient(http.StatusUnauthorized, "nope", &rec)
		if _, err := (codexProvider{}).RefreshCredentials(context.Background(), client, "old", appdb.ProviderAccount{}); err == nil {
			t.Fatal("error = nil, want error")
		}
	})

	t.Run("empty access token", func(t *testing.T) {
		t.Parallel()
		var rec recordedRequest
		client := recordingClient(http.StatusOK, `{}`, &rec)
		if _, err := (codexProvider{}).RefreshCredentials(context.Background(), client, "old", appdb.ProviderAccount{}); err == nil {
			t.Fatal("error = nil, want empty access token error")
		}
	})
}

func TestWorkbuddyMakeRequest(t *testing.T) {
	t.Parallel()
	t.Run("requires user id", func(t *testing.T) {
		t.Parallel()
		var rec recordedRequest
		client := recordingClient(http.StatusOK, "{}", &rec)
		if _, err := (workbuddyProvider{}).MakeRequest(context.Background(), client, "tok", appdb.ProviderAccount{}, map[string]any{"model": "workbuddy/m"}, false); err == nil {
			t.Fatal("error = nil, want missing user id error")
		}
	})

	t.Run("builds payload and converts non-stream response", func(t *testing.T) {
		t.Parallel()
		var rec recordedRequest
		sse := "data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}\n\n" +
			"data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1}}\n\n"
		client := recordingClient(http.StatusOK, sse, &rec)
		uid := "user_1"

		resp, err := workbuddyProvider{}.MakeRequest(context.Background(), client, "tok", appdb.ProviderAccount{ID: "acc", AccountID: &uid}, map[string]any{"model": "workbuddy/gpt-oss", "messages": []any{map[string]any{"role": "user", "content": "hi"}}}, false)
		if err != nil {
			t.Fatalf("MakeRequest: %v", err)
		}
		if rec.req.URL.String() != workbuddyAPIBase+workbuddyChatPath {
			t.Fatalf("url = %q", rec.req.URL.String())
		}
		if got := rec.req.Header.Get("X-User-Id"); got != "user_1" {
			t.Fatalf("X-User-Id = %q", got)
		}
		if got := rec.req.Header.Get("X-Domain"); got != workbuddyDomain {
			t.Fatalf("X-Domain = %q", got)
		}
		var payload map[string]any
		_ = json.Unmarshal(rec.body, &payload)
		if payload["max_tokens"] != float64(workbuddyDefaultMaxTokens) {
			t.Fatalf("max_tokens = %v, want default", payload["max_tokens"])
		}
		if payload["stream"] != true {
			t.Fatalf("stream = %v, want true", payload["stream"])
		}
		messages, _ := payload["messages"].([]any)
		if len(messages) != 2 {
			t.Fatalf("messages = %d, want system + user", len(messages))
		}
		first, _ := messages[0].(map[string]any)
		if first["role"] != "system" {
			t.Fatalf("first message = %v, want system", first)
		}
		decoded := map[string]any{}
		_ = json.NewDecoder(resp.Body).Decode(&decoded)
		choices, _ := decoded["choices"].([]any)
		choice, _ := choices[0].(map[string]any)
		message, _ := choice["message"].(map[string]any)
		if message["content"] != "Hello" {
			t.Fatalf("content = %v, want Hello", message["content"])
		}
	})
}

func TestWorkbuddyRefreshCredentials(t *testing.T) {
	t.Parallel()
	t.Run("success", func(t *testing.T) {
		t.Parallel()
		var rec recordedRequest
		client := recordingClient(http.StatusOK, `{"code":0,"data":{"accessToken":"at","refreshToken":"rt","expiresIn":3600}}`, &rec)
		creds, err := workbuddyProvider{}.RefreshCredentials(context.Background(), client, "old", appdb.ProviderAccount{})
		if err != nil {
			t.Fatalf("RefreshCredentials: %v", err)
		}
		if creds.AccessToken != "at" || creds.RefreshToken != "rt" {
			t.Fatalf("creds = %+v", creds)
		}
		if got := rec.req.Header.Get("X-Refresh-Token"); got != "old" {
			t.Fatalf("X-Refresh-Token = %q", got)
		}
		if got := rec.req.Header.Get("X-Auth-Refresh-Source"); got != workbuddyRefreshSource {
			t.Fatalf("refresh source = %q", got)
		}
	})

	t.Run("non zero code", func(t *testing.T) {
		t.Parallel()
		var rec recordedRequest
		client := recordingClient(http.StatusOK, `{"code":1,"msg":"bad","data":{"accessToken":"at"}}`, &rec)
		if _, err := (workbuddyProvider{}).RefreshCredentials(context.Background(), client, "old", appdb.ProviderAccount{}); err == nil {
			t.Fatal("error = nil, want error for non-zero code")
		}
	})

	t.Run("http error", func(t *testing.T) {
		t.Parallel()
		var rec recordedRequest
		client := recordingClient(http.StatusBadGateway, "down", &rec)
		if _, err := (workbuddyProvider{}).RefreshCredentials(context.Background(), client, "old", appdb.ProviderAccount{}); err == nil {
			t.Fatal("error = nil, want error")
		}
	})
}

func TestWorkbuddyExpiry(t *testing.T) {
	t.Parallel()
	if got := workbuddyExpiry(1_700_000_000, 0); got.Unix() != 1_700_000_000 {
		t.Fatalf("seconds expiry = %v", got)
	}
	if got := workbuddyExpiry(1_700_000_000_000, 0); got.UnixMilli() != 1_700_000_000_000 {
		t.Fatalf("millis expiry = %v", got)
	}
	if got := workbuddyExpiry(0, 60); time.Until(got) < 59*time.Second {
		t.Fatalf("expiresIn expiry = %v", got)
	}
	if got := workbuddyExpiry(0, 0); time.Until(got) < 300*24*time.Hour {
		t.Fatalf("fallback expiry = %v, want long-lived", got)
	}
}

func TestWorkbuddyEnsureSystemMessage(t *testing.T) {
	t.Parallel()
	converted := workbuddyEnsureSystemMessage([]any{map[string]any{"role": "developer", "content": "rules"}})
	first, _ := converted[0].(map[string]any)
	if first["role"] != "system" {
		t.Fatalf("developer not converted to system: %v", first)
	}

	preserved := workbuddyEnsureSystemMessage([]any{map[string]any{"role": "system", "content": "custom"}, map[string]any{"role": "user"}})
	if len(preserved) != 2 {
		t.Fatalf("existing system should be preserved: %v", preserved)
	}

	injected := workbuddyEnsureSystemMessage([]any{map[string]any{"role": "user", "content": "hi"}})
	if len(injected) != 2 {
		t.Fatalf("default system not injected: %v", injected)
	}
	tail, _ := injected[1].(map[string]any)
	if tail["role"] != "user" {
		t.Fatalf("user message position wrong: %v", tail)
	}
}

func TestWorkbuddyDeltaText(t *testing.T) {
	t.Parallel()
	if got := workbuddyDeltaText("hello"); got != "hello" {
		t.Fatalf("string = %q", got)
	}
	if got := workbuddyDeltaText([]any{map[string]any{"text": "a"}, map[string]any{"content": "b"}}); got != "ab" {
		t.Fatalf("parts = %q, want ab", got)
	}
	if got := workbuddyDeltaText(42); got != "" {
		t.Fatalf("unsupported = %q, want empty", got)
	}
}

func TestWorkbuddyStreamToCompletionAssemblesToolCalls(t *testing.T) {
	t.Parallel()
	sse := strings.Join([]string{
		`data: {"choices":[{"delta":{"content":"Hi"}}]}`,
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"foo","arguments":"{\"a\""}}]}}]}`,
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":1}"}}]}}]}`,
	}, "\n\n")
	result := workbuddyStreamToCompletion(strings.NewReader(sse), "m")
	choices, _ := result["choices"].([]any)
	choice, _ := choices[0].(map[string]any)
	if choice["finish_reason"] != "tool_calls" {
		t.Fatalf("finish = %v, want tool_calls", choice["finish_reason"])
	}
	message, _ := choice["message"].(map[string]any)
	if message["content"] != "Hi" {
		t.Fatalf("content = %v, want Hi", message["content"])
	}
	calls, _ := message["tool_calls"].([]any)
	call, _ := calls[0].(map[string]any)
	fn, _ := call["function"].(map[string]any)
	if call["id"] != "call_1" || fn["arguments"] != `{"a":1}` {
		t.Fatalf("tool call = %v", call)
	}
}
