package providers

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
)

type recordedRequest struct {
	req  *http.Request
	body []byte
}

func recordingClient(status int, responseBody string, rec *recordedRequest) *http.Client {
	return &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		rec.req = req
		if req.Body != nil {
			rec.body, _ = io.ReadAll(req.Body)
		}
		return &http.Response{
			StatusCode: status,
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Body:       io.NopCloser(strings.NewReader(responseBody)),
			Request:    req,
		}, nil
	})}
}

func openRouterProvider() openAICompatibleProvider {
	return openAICompatibleProvider{
		name:            "openrouter",
		baseURL:         "https://mock.test/api/v1",
		supportedParams: supportedOpenRouter,
		trimPrefix:      "openrouter/",
	}
}

func TestOpenRouterMakeRequestBuildsChatPayload(t *testing.T) {
	t.Parallel()
	var rec recordedRequest
	client := recordingClient(http.StatusOK, `{"ok":true}`, &rec)
	provider := openRouterProvider()

	body := map[string]any{
		"model":       "openrouter/anthropic/claude-3",
		"messages":    []any{map[string]any{"role": "user", "content": "hi"}},
		"temperature": 0.5,
		"unsupported": "dropped",
	}
	resp, err := provider.MakeRequest(context.Background(), client, "key123", appdb.ProviderAccount{}, body, false)
	if err != nil {
		t.Fatalf("MakeRequest: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if rec.req.URL.String() != "https://mock.test/api/v1/chat/completions" {
		t.Fatalf("url = %q", rec.req.URL.String())
	}
	if rec.req.Method != http.MethodPost {
		t.Fatalf("method = %q, want POST", rec.req.Method)
	}
	if got := rec.req.Header.Get("Authorization"); got != "Bearer key123" {
		t.Fatalf("Authorization = %q", got)
	}
	if got := rec.req.Header.Get("Accept"); got != "application/json" {
		t.Fatalf("Accept = %q, want application/json", got)
	}

	var payload map[string]any
	if err := json.Unmarshal(rec.body, &payload); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	if payload["model"] != "anthropic/claude-3" {
		t.Fatalf("model = %v, want trimmed anthropic/claude-3", payload["model"])
	}
	if payload["temperature"] != 0.5 {
		t.Fatalf("temperature = %v", payload["temperature"])
	}
	if payload["stream"] != false {
		t.Fatalf("stream = %v, want false", payload["stream"])
	}
	if _, ok := payload["unsupported"]; ok {
		t.Fatal("unsupported param leaked into payload")
	}
}

func TestOpenRouterMakeRequestStreamUsesSSEAccept(t *testing.T) {
	t.Parallel()
	var rec recordedRequest
	client := recordingClient(http.StatusOK, "data: [DONE]\n\n", &rec)
	provider := openRouterProvider()

	if _, err := provider.MakeRequest(context.Background(), client, "key123", appdb.ProviderAccount{}, map[string]any{"model": "openrouter/m", "messages": []any{}}, true); err != nil {
		t.Fatalf("MakeRequest: %v", err)
	}
	if got := rec.req.Header.Get("Accept"); got != "text/event-stream" {
		t.Fatalf("Accept = %q, want text/event-stream", got)
	}
	var payload map[string]any
	_ = json.Unmarshal(rec.body, &payload)
	if payload["stream"] != true {
		t.Fatalf("stream = %v, want true", payload["stream"])
	}
}

func TestOpenRouterMakeRequestReturnsUpstreamErrorResponse(t *testing.T) {
	t.Parallel()
	var rec recordedRequest
	client := recordingClient(http.StatusTooManyRequests, "rate limited", &rec)
	provider := openRouterProvider()

	resp, err := provider.MakeRequest(context.Background(), client, "key123", appdb.ProviderAccount{}, map[string]any{"model": "openrouter/m", "messages": []any{}}, false)
	if err != nil {
		t.Fatalf("MakeRequest: %v", err)
	}
	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", resp.StatusCode)
	}
}

func TestOpenRouterMakeRequestUsesResponsesAPIWhenFlagged(t *testing.T) {
	t.Parallel()
	var rec recordedRequest
	client := recordingClient(http.StatusOK, `{"output":[],"usage":{}}`, &rec)
	provider := openRouterProvider()
	provider.modelFlags = func(string) map[string]any { return map[string]any{"responses_api": true} }

	resp, err := provider.MakeRequest(context.Background(), client, "key123", appdb.ProviderAccount{}, map[string]any{"model": "openrouter/m", "messages": []any{map[string]any{"role": "user", "content": "hi"}}}, false)
	if err != nil {
		t.Fatalf("MakeRequest: %v", err)
	}
	if !strings.HasSuffix(rec.req.URL.Path, "/responses") {
		t.Fatalf("path = %q, want /responses", rec.req.URL.Path)
	}
	decoded := make(map[string]any)
	if err := json.NewDecoder(resp.Body).Decode(&decoded); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if decoded["object"] != "chat.completion" {
		t.Fatalf("object = %v, want chat.completion", decoded["object"])
	}
}

func TestClineMakeRequestSendsHeadersAndTrimsModel(t *testing.T) {
	t.Parallel()
	var rec recordedRequest
	client := recordingClient(http.StatusOK, `{"ok":true}`, &rec)

	resp, err := clineProvider{}.MakeRequest(context.Background(), client, "cred", appdb.ProviderAccount{}, map[string]any{"model": "cline/claude", "messages": []any{}, "unsupported": "x"}, false)
	if err != nil {
		t.Fatalf("MakeRequest: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	if rec.req.URL.String() != clineAPIBase+clineChatPath {
		t.Fatalf("url = %q", rec.req.URL.String())
	}
	if got := rec.req.Header.Get("Authorization"); got != "Bearer cred" {
		t.Fatalf("Authorization = %q", got)
	}
	for header, want := range clineRequestHeaders {
		if got := rec.req.Header.Get(header); got != want {
			t.Fatalf("header %s = %q, want %q", header, got, want)
		}
	}
	var payload map[string]any
	_ = json.Unmarshal(rec.body, &payload)
	if payload["model"] != "claude" {
		t.Fatalf("model = %v, want claude", payload["model"])
	}
	if _, ok := payload["unsupported"]; ok {
		t.Fatal("unsupported param leaked into payload")
	}
}

func TestClineRefreshCredentials(t *testing.T) {
	t.Parallel()

	t.Run("success", func(t *testing.T) {
		t.Parallel()
		var rec recordedRequest
		client := recordingClient(http.StatusOK, `{"data":{"accessToken":"tok","refreshToken":"r2"}}`, &rec)
		creds, err := clineProvider{}.RefreshCredentials(context.Background(), client, "r1", appdb.ProviderAccount{})
		if err != nil {
			t.Fatalf("RefreshCredentials: %v", err)
		}
		if creds.AccessToken != "workos:tok" || creds.RefreshToken != "r2" {
			t.Fatalf("creds = %+v", creds)
		}
		if until := time.Until(creds.ExpiresAt); until < 59*time.Minute || until > time.Hour {
			t.Fatalf("expiry = %v, want about one hour", until)
		}
		var payload map[string]any
		_ = json.Unmarshal(rec.body, &payload)
		if payload["refreshToken"] != "r1" || payload["grantType"] != "refresh_token" {
			t.Fatalf("refresh payload = %v", payload)
		}
	})

	t.Run("keeps existing refresh token", func(t *testing.T) {
		t.Parallel()
		var rec recordedRequest
		client := recordingClient(http.StatusOK, `{"data":{"accessToken":"tok"}}`, &rec)
		creds, err := clineProvider{}.RefreshCredentials(context.Background(), client, "r1", appdb.ProviderAccount{})
		if err != nil {
			t.Fatalf("RefreshCredentials: %v", err)
		}
		if creds.RefreshToken != "r1" {
			t.Fatalf("refresh token = %q, want r1", creds.RefreshToken)
		}
	})

	t.Run("upstream error", func(t *testing.T) {
		t.Parallel()
		var rec recordedRequest
		client := recordingClient(http.StatusUnauthorized, "nope", &rec)
		if _, err := (clineProvider{}).RefreshCredentials(context.Background(), client, "r1", appdb.ProviderAccount{}); err == nil {
			t.Fatal("error = nil, want error")
		}
	})

	t.Run("empty access token", func(t *testing.T) {
		t.Parallel()
		var rec recordedRequest
		client := recordingClient(http.StatusOK, `{"data":{}}`, &rec)
		if _, err := (clineProvider{}).RefreshCredentials(context.Background(), client, "r1", appdb.ProviderAccount{}); err == nil {
			t.Fatal("error = nil, want error for empty access token")
		}
	})
}

func TestWorkersAIMakeRequestRequiresAccountID(t *testing.T) {
	t.Parallel()
	rec := &recordedRequest{}
	client := recordingClient(http.StatusOK, `{}`, rec)
	if _, err := (workersAIProvider{}).MakeRequest(context.Background(), client, "cred", appdb.ProviderAccount{}, map[string]any{"model": "m"}, false); err == nil {
		t.Fatal("error = nil, want missing account id error")
	}
}

func TestOpenRouterMakeRequestEncodesJSONBody(t *testing.T) {
	t.Parallel()
	var rec recordedRequest
	client := recordingClient(http.StatusOK, `{}`, &rec)
	provider := openRouterProvider()
	if _, err := provider.MakeRequest(context.Background(), client, "k", appdb.ProviderAccount{}, map[string]any{"model": "openrouter/m", "messages": []any{map[string]any{"role": "user", "content": "hi"}}}, false); err != nil {
		t.Fatalf("MakeRequest: %v", err)
	}
	if !bytes.Contains(rec.body, []byte(`"messages"`)) {
		t.Fatalf("body = %s, want messages field", rec.body)
	}
}
