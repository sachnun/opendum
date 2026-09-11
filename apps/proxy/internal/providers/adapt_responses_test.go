package providers

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
)

type stubProvider struct {
	native bool
}

func (s stubProvider) MakeRequest(ctx context.Context, client *http.Client, credentials string, account appdb.ProviderAccount, body map[string]any, stream bool) (*http.Response, error) {
	return nil, nil
}

func (s stubProvider) ResponsesNative(string) bool { return s.native }

func newChatResponse(body string) *http.Response {
	return &http.Response{StatusCode: http.StatusOK, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body))}
}

func TestAdaptForResponsesClientConvertsChatUpstream(t *testing.T) {
	resp := newChatResponse(`{"id":"chatcmpl_1","choices":[{"message":{"content":"PONG"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2}}`)
	payload := map[string]any{"model": "m", "_responsesInput": []any{}}

	out, err := AdaptForResponsesClient(stubProvider{}, resp, payload, false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	body, _ := io.ReadAll(out.Body)
	if !strings.Contains(string(body), `"object":"response"`) {
		t.Fatalf("response was not converted to Responses shape: %s", body)
	}
	if strings.Contains(string(body), `"object":"chat.completion"`) {
		t.Fatalf("chat.completion leaked to a Responses client: %s", body)
	}
}

func TestAdaptForResponsesClientPassesThroughNativeProviders(t *testing.T) {
	original := `{"id":"resp_1","object":"response","output":[]}`
	resp := newChatResponse(original)
	payload := map[string]any{"model": "m", "_responsesInput": []any{}}

	out, err := AdaptForResponsesClient(stubProvider{native: true}, resp, payload, false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	body, _ := io.ReadAll(out.Body)
	if string(body) != original {
		t.Fatalf("native responses payload was modified: %s", body)
	}
}

func TestAdaptForResponsesClientIgnoresChatClients(t *testing.T) {
	original := `{"id":"chatcmpl_1","object":"chat.completion","choices":[]}`
	resp := newChatResponse(original)
	payload := map[string]any{"model": "m"}

	out, err := AdaptForResponsesClient(stubProvider{}, resp, payload, false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	body, _ := io.ReadAll(out.Body)
	if string(body) != original {
		t.Fatalf("chat payload was modified for a chat client: %s", body)
	}
}

func TestRealRegistryProvidersReportResponsesNative(t *testing.T) {
	registry := testModelsRegistry(t)
	providers := NewRegistry(registry, nil, nil)

	openAICompatible, ok := providers.providers["harbor"].(openAICompatibleProvider)
	if !ok {
		t.Fatalf("harbor provider type = %T", providers.providers["harbor"])
	}
	if openAICompatible.ResponsesNative("deepseek-v4.1-flash") {
		t.Fatal("harbor should not be treated as responses-native")
	}

	opencode, ok := providers.providers["opencode"].(opencodeProvider)
	if !ok {
		t.Fatalf("opencode provider type = %T", providers.providers["opencode"])
	}
	if !opencode.ResponsesNative("muse-spark-1.3-contributor") {
		t.Fatal("muse-spark-1.3-contributor should be responses-native on opencode")
	}
	if opencode.ResponsesNative("big-pickle") {
		t.Fatal("big-pickle should not be responses-native on opencode")
	}
}
