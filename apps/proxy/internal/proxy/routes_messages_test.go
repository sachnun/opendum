package proxy

import (
	"net/http"
	"reflect"
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
