package providers

import (
	"encoding/json"
	"io"
	"strings"
	"testing"
)

func TestKiroBuildRequestConvertsMessagesAndTools(t *testing.T) {
	provider := kiroProvider{}
	payload := provider.buildRequest(map[string]any{
		"model": "kiro/unit-test-model",
		"messages": []any{
			map[string]any{"role": "user", "content": "hello"},
			map[string]any{"role": "assistant", "content": "", "tool_calls": []any{map[string]any{"id": "toolu_1", "function": map[string]any{"name": "lookup", "arguments": `{"city":"Jakarta"}`}}}},
			map[string]any{"role": "tool", "tool_call_id": "toolu_1", "content": "sunny"},
		},
		"tools": []any{map[string]any{"type": "function", "function": map[string]any{"name": "lookup", "description": "Lookup", "parameters": map[string]any{"type": "object"}}}},
	})

	state := payload["conversationState"].(map[string]any)
	history := state["history"].([]any)
	if len(history) != 2 {
		t.Fatalf("history len = %d, want 2: %#v", len(history), history)
	}
	current := state["currentMessage"].(map[string]any)["userInputMessage"].(map[string]any)
	if current["content"] != "sunny" {
		t.Fatalf("current content = %q, want sunny", current["content"])
	}
	ctx := current["userInputMessageContext"].(map[string]any)
	if len(ctx["tools"].([]any)) != 1 || len(ctx["toolResults"].([]any)) != 1 {
		t.Fatalf("current context = %#v", ctx)
	}
}

func TestKiroJSONEventParsingAndCompletion(t *testing.T) {
	events := parseKiroJSONEvents(`prefix {"content":"hello "}{"name":"lookup","toolUseId":"toolu_1"}{"input":"{\"city\":"}{"input":"\"Jakarta\"}"}{"stop":true}`, &kiroParserState{})
	if len(events) != 5 {
		t.Fatalf("events len = %d, want 5: %#v", len(events), events)
	}
	completion := convertKiroEventsToCompletion(events, "unit-test-model")
	choices := completion["choices"].([]any)
	message := choices[0].(map[string]any)["message"].(map[string]any)
	if message["content"] != "hello " {
		t.Fatalf("content = %q, want hello", message["content"])
	}
	toolCalls := message["tool_calls"].([]any)
	fn := toolCalls[0].(map[string]any)["function"].(map[string]any)
	if fn["name"] != "lookup" || fn["arguments"] != `{"city":"Jakarta"}` {
		t.Fatalf("tool call function = %#v", fn)
	}
}

func TestKiroSSEReader(t *testing.T) {
	reader := newKiroSSEReader(strings.NewReader(`{"content":"hello"}{"stop":true}`), "unit-test-model")
	out, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	text := string(out)
	if !strings.Contains(text, "data: [DONE]") {
		t.Fatalf("missing done: %s", text)
	}
	chunks := strings.Split(text, "\n\n")
	foundContent := false
	for _, chunk := range chunks {
		if !strings.HasPrefix(chunk, "data: {") {
			continue
		}
		var parsed map[string]any
		if err := json.Unmarshal([]byte(strings.TrimPrefix(chunk, "data: ")), &parsed); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(chunk, `"content":"hello"`) {
			foundContent = true
		}
	}
	if !foundContent {
		t.Fatalf("missing content chunk: %s", text)
	}
}
