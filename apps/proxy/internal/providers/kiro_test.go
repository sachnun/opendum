package providers

import (
	"encoding/json"
	"io"
	"strings"
	"testing"

	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
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
	if current["content"] != "Tool results provided." {
		t.Fatalf("current content = %q, want tool-result placeholder", current["content"])
	}
	ctx := current["userInputMessageContext"].(map[string]any)
	if len(ctx["tools"].([]any)) != 1 || len(ctx["toolResults"].([]any)) != 1 {
		t.Fatalf("current context = %#v", ctx)
	}
	toolResult := ctx["toolResults"].([]any)[0].(map[string]any)
	if contentToText(toolResult["content"]) != "sunny" {
		t.Fatalf("tool result text = %#v, want sunny", toolResult)
	}
}

func TestKiroBuildRequestInjectsSystemThinkingAndAnthropicTools(t *testing.T) {
	provider := kiroProvider{}
	payload := provider.buildRequest(map[string]any{
		"model":             "kiro/unit-test-model",
		"_includeReasoning": true,
		"thinking_budget":   1234,
		"messages": []any{
			map[string]any{"role": "system", "content": "follow policy"},
			map[string]any{"role": "user", "content": "hello"},
		},
		"tools": []any{map[string]any{"name": "lookup", "description": "Lookup", "input_schema": map[string]any{"type": "object"}}},
	})

	state := payload["conversationState"].(map[string]any)
	current := state["currentMessage"].(map[string]any)["userInputMessage"].(map[string]any)
	content := current["content"].(string)
	if !strings.Contains(content, "<thinking_mode>enabled</thinking_mode><max_thinking_length>1234</max_thinking_length>") || !strings.Contains(content, "follow policy") || !strings.Contains(content, "hello") {
		t.Fatalf("current content missing thinking/system/user text: %q", content)
	}
	tools := current["userInputMessageContext"].(map[string]any)["tools"].([]any)
	spec := tools[0].(map[string]any)["toolSpecification"].(map[string]any)
	if spec["name"] != "lookup" {
		t.Fatalf("tool spec = %#v", spec)
	}
}

func TestKiroJSONEventParsingAndCompletion(t *testing.T) {
	events := parseKiroJSONEvents(`prefix {"content":"hello "}{"name":"lookup","toolUseId":"toolu_1","input":"{\"city\":"}{"input":"\"Jakarta\"}"}{"stop":true}`, &kiroParserState{})
	if len(events) != 4 {
		t.Fatalf("events len = %d, want 4: %#v", len(events), events)
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

func TestKiroCompletionExtractsThinkingAndUsage(t *testing.T) {
	events := parseKiroJSONEvents(`{"content":"<thinking>plan</thinking>\n\nanswer"}{"contextUsagePercentage":1}`, &kiroParserState{})
	completion := convertKiroEventsToCompletion(events, "unit-test-model")
	choice := completion["choices"].([]any)[0].(map[string]any)
	message := choice["message"].(map[string]any)
	if message["content"] != "answer" || message["reasoning_content"] != "plan" {
		t.Fatalf("message = %#v", message)
	}
	usage := completion["usage"].(map[string]any)
	if usage["prompt_tokens"].(int) <= 0 || usage["completion_tokens"].(int) <= 0 {
		t.Fatalf("usage = %#v", usage)
	}
}

func TestKiroCompletionParsesBracketToolCalls(t *testing.T) {
	events := parseKiroJSONEvents(`{"content":"I will call [Called lookup with args: {\"city\":\"Jakarta\"}]"}`, &kiroParserState{})
	completion := convertKiroEventsToCompletion(events, "unit-test-model")
	choice := completion["choices"].([]any)[0].(map[string]any)
	if choice["finish_reason"] != "tool_calls" {
		t.Fatalf("finish = %#v", choice["finish_reason"])
	}
	message := choice["message"].(map[string]any)
	if message["content"] != "I will call" {
		t.Fatalf("content = %#v", message["content"])
	}
	toolCalls := message["tool_calls"].([]any)
	fn := toolCalls[0].(map[string]any)["function"].(map[string]any)
	if fn["name"] != "lookup" || fn["arguments"] != `{"city":"Jakarta"}` {
		t.Fatalf("tool call function = %#v", fn)
	}
}

func TestKiroSSEReader(t *testing.T) {
	reader := newKiroSSEReader(strings.NewReader(`{"content":"hello"}{"contextUsagePercentage":0.5}{"stop":true}`), "unit-test-model")
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
	if !strings.Contains(text, `"usage"`) {
		t.Fatalf("missing usage chunk: %s", text)
	}
}

func TestKiroAPIURLUsesProfileARNRegion(t *testing.T) {
	profileArn := "arn:aws:codecatalyst:eu-west-1:123456789012:space/test"
	got := kiroAPIURLForAccount(appdb.ProviderAccount{AccountID: &profileArn})
	if got != "https://q.eu-west-1.amazonaws.com/generateAssistantResponse" {
		t.Fatalf("url = %q", got)
	}
}
