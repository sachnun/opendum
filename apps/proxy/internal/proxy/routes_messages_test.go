package proxy

import (
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

func TestParseMessagesBuildsProviderPayload(t *testing.T) {
	body := map[string]any{
		"model":      "claude-alias",
		"system":     "follow policy",
		"messages":   []any{map[string]any{"role": "user", "content": "hello"}},
		"stream":     false,
		"max_tokens": 200,
		"thinking":   map[string]any{"type": "enabled", "budget_tokens": 1024},
	}

	parsed, routeErr := parseMessages(body)
	if routeErr != nil {
		t.Fatalf("parseMessages returned error: %+v", routeErr)
	}
	if parsed.ModelParam != "claude-alias" {
		t.Fatalf("ModelParam = %q, want claude-alias", parsed.ModelParam)
	}
	if parsed.Stream {
		t.Fatal("Stream = true, want false")
	}
	if parsed.ForcedAccountID != nil {
		t.Fatalf("ForcedAccountID = %v, want nil", parsed.ForcedAccountID)
	}
	if !reflect.DeepEqual(parsed.MessagesForError, body["messages"]) {
		t.Fatalf("MessagesForError = %#v, want original messages", parsed.MessagesForError)
	}
	if parsed.ParamsForError["model"] != nil || parsed.ParamsForError["messages"] != nil {
		t.Fatalf("ParamsForError contains request-only fields: %#v", parsed.ParamsForError)
	}
	if parsed.ParamsForError["stream"] != false {
		t.Fatalf("ParamsForError missing stream: %#v", parsed.ParamsForError)
	}

	payload := buildMessages(parsed, "claude-canonical", true, "sess_3")
	if payload["model"] != "claude-canonical" {
		t.Fatalf("payload model = %q, want claude-canonical", payload["model"])
	}
	if payload["stream"] != true {
		t.Fatalf("payload stream = %v, want true", payload["stream"])
	}
	if payload["_sessionId"] != "sess_3" {
		t.Fatalf("payload _sessionId = %v, want sess_3", payload["_sessionId"])
	}
	if payload["_includeReasoning"] != true || payload["thinking_budget"] != 1024 {
		t.Fatalf("payload missing thinking metadata: %#v", payload)
	}
	if payload["system"] != nil {
		t.Fatalf("payload leaked request-only fields: %#v", payload)
	}

	messages, ok := payload["messages"].([]any)
	if !ok || len(messages) != 2 {
		t.Fatalf("payload messages = %#v, want 2 converted messages", payload["messages"])
	}
	assertMessage(t, messages[0], "system", "follow policy")
	assertMessage(t, messages[1], "user", "hello")
}

func TestParseMessagesDefaultsStreamFalseAndValidatesModel(t *testing.T) {
	parsed, routeErr := parseMessages(map[string]any{
		"model":    "claude-alias",
		"messages": []any{},
	})
	if routeErr != nil {
		t.Fatalf("parseMessages returned error: %+v", routeErr)
	}
	if parsed.Stream {
		t.Fatal("Stream = true, want default false")
	}

	_, routeErr = parseMessages(map[string]any{"messages": []any{}})
	if routeErr == nil {
		t.Fatal("parseMessages returned nil error")
	}
	if routeErr.Status != http.StatusBadRequest || routeErr.Message != "model is required" || routeErr.Type != "invalid_request_error" {
		t.Fatalf("routeErr = %+v", routeErr)
	}
}

func TestTransformOpenAIToAnthropicPreservesCachedTokens(t *testing.T) {
	openAI := map[string]any{
		"id":    "chatcmpl_test",
		"model": "claude-sonnet",
		"choices": []any{
			map[string]any{
				"index": 0,
				"message": map[string]any{
					"role":    "assistant",
					"content": "Hello world",
				},
				"finish_reason": "stop",
			},
		},
		"usage": map[string]any{
			"prompt_tokens":     1200,
			"completion_tokens": 150,
			"total_tokens":      1350,
			"prompt_tokens_details": map[string]any{
				"cached_tokens": 1000,
			},
		},
	}

	anthropic := transformOpenAIToAnthropic(openAI, "claude-sonnet")
	usage, ok := anthropic["usage"].(map[string]any)
	if !ok {
		t.Fatalf("anthropic usage missing: %#v", anthropic["usage"])
	}
	if usage["input_tokens"] != 1200 || usage["output_tokens"] != 150 {
		t.Fatalf("usage tokens mismatch: %#v", usage)
	}
	if usage["cache_read_input_tokens"] != 1000 {
		t.Fatalf("cache_read_input_tokens = %v, want 1000", usage["cache_read_input_tokens"])
	}
}

func TestAnthropicStreamTrackerPreservesCachedTokens(t *testing.T) {
	recorder := &fakeResponseWriter{}
	tracker := &anthropicStreamTracker{
		writer:  recorder,
		flusher: fakeFlusher{},
	}

	tracker.Process("data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Hello\"}}]}\n\n")
	tracker.Process("data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":800,\"completion_tokens\":40,\"prompt_tokens_details\":{\"cached_tokens\":650}}}\n\n")
	tracker.Finish()

	var deltaUsage map[string]any
	for _, event := range recorder.events {
		if event.name == "message_delta" {
			if u, ok := event.data["usage"].(map[string]any); ok {
				deltaUsage = u
			}
		}
	}

	if deltaUsage == nil {
		t.Fatal("message_delta usage event not found")
	}
	if numberAsInt(deltaUsage["input_tokens"]) != 800 || numberAsInt(deltaUsage["output_tokens"]) != 40 {
		t.Fatalf("deltaUsage tokens mismatch: input=%v, output=%v", deltaUsage["input_tokens"], deltaUsage["output_tokens"])
	}
	if numberAsInt(deltaUsage["cache_read_input_tokens"]) != 650 {
		t.Fatalf("cache_read_input_tokens = %v, want 650: %#v", deltaUsage["cache_read_input_tokens"], deltaUsage)
	}
}

type fakeEvent struct {
	name string
	data map[string]any
}

type fakeResponseWriter struct {
	headers http.Header
	status  int
	events  []fakeEvent
}

func (f *fakeResponseWriter) Header() http.Header {
	if f.headers == nil {
		f.headers = make(http.Header)
	}
	return f.headers
}

func (f *fakeResponseWriter) Write(b []byte) (int, error) {
	text := string(b)
	for _, part := range strings.Split(text, "\n\n") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		lines := strings.Split(part, "\n")
		var eventName string
		var data map[string]any
		for _, line := range lines {
			if strings.HasPrefix(line, "event: ") {
				eventName = strings.TrimPrefix(line, "event: ")
			} else if strings.HasPrefix(line, "data: ") {
				_ = json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &data)
			}
		}
		if eventName != "" && data != nil {
			f.events = append(f.events, fakeEvent{name: eventName, data: data})
		}
	}
	return len(b), nil
}

func (f *fakeResponseWriter) WriteHeader(statusCode int) {
	f.status = statusCode
}

type fakeFlusher struct{}

func (fakeFlusher) Flush() {}

