package providers

import (
	"encoding/json"
	"io"
	"strings"
	"testing"

	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
)

type oneByteReader struct {
	data []byte
	pos  int
}

func (r *oneByteReader) Read(p []byte) (int, error) {
	if r.pos >= len(r.data) {
		return 0, io.EOF
	}
	p[0] = r.data[r.pos]
	r.pos++
	return 1, nil
}

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

func TestKiroBuildRequestAttachesToolResultsToNextUser(t *testing.T) {
	provider := kiroProvider{}
	messages := []any{
		map[string]any{"role": "user", "content": "read file"},
		map[string]any{"role": "assistant", "content": "", "tool_calls": []any{map[string]any{"id": "toolu_1", "function": map[string]any{"name": "read", "arguments": `{"path":"a.txt"}`}}}},
		map[string]any{"role": "tool", "tool_call_id": "toolu_1", "content": "file contents"},
		map[string]any{"role": "user", "content": "summarize it"},
	}
	payload := provider.buildRequest(map[string]any{
		"model":    "kiro/unit-test-model",
		"messages": messages,
	})

	state := payload["conversationState"].(map[string]any)
	history := state["history"].([]any)
	assistant := history[1].(map[string]any)["assistantResponseMessage"].(map[string]any)
	if len(assistant["toolUses"].([]any)) != 1 {
		t.Fatalf("assistant toolUses = %#v, want one matching tool use", assistant["toolUses"])
	}
	current := state["currentMessage"].(map[string]any)["userInputMessage"].(map[string]any)
	if current["content"] != "summarize it" {
		t.Fatalf("current content = %#v, want user text", current["content"])
	}
	currentResults := current["userInputMessageContext"].(map[string]any)["toolResults"].([]any)
	if len(currentResults) != 1 || currentResults[0].(map[string]any)["toolUseId"] != "toolu_1" {
		t.Fatalf("current toolResults = %#v, want toolu_1", currentResults)
	}
}

func TestKiroBuildRequestInsertsSyntheticUserForToolResultsBeforeAssistant(t *testing.T) {
	provider := kiroProvider{}
	payload := provider.buildRequest(map[string]any{
		"model": "kiro/unit-test-model",
		"messages": []any{
			map[string]any{"role": "user", "content": "read file"},
			map[string]any{"role": "assistant", "content": "", "tool_calls": []any{map[string]any{"id": "toolu_1", "function": map[string]any{"name": "read", "arguments": `{"path":"a.txt"}`}}}},
			map[string]any{"role": "tool", "tool_call_id": "toolu_1", "content": "file contents"},
			map[string]any{"role": "assistant", "content": "I read it."},
			map[string]any{"role": "user", "content": "continue"},
		},
	})

	state := payload["conversationState"].(map[string]any)
	history := state["history"].([]any)
	if len(history) != 4 {
		t.Fatalf("history len = %d, want 4: %#v", len(history), history)
	}
	toolResultUser := history[2].(map[string]any)["userInputMessage"].(map[string]any)
	if toolResultUser["content"] != "Tool results provided." {
		t.Fatalf("tool result user content = %#v", toolResultUser["content"])
	}
	results := toolResultUser["userInputMessageContext"].(map[string]any)["toolResults"].([]any)
	if len(results) != 1 || results[0].(map[string]any)["toolUseId"] != "toolu_1" {
		t.Fatalf("synthetic toolResults = %#v, want toolu_1", results)
	}
	secondAssistant := history[3].(map[string]any)["assistantResponseMessage"].(map[string]any)
	if secondAssistant["content"] != "I read it." {
		t.Fatalf("second assistant = %#v", secondAssistant)
	}
}

func TestKiroBuildRequestStripsOrphanedToolUses(t *testing.T) {
	provider := kiroProvider{}
	payload := provider.buildRequest(map[string]any{
		"model": "kiro/unit-test-model",
		"messages": []any{
			map[string]any{"role": "user", "content": "read file"},
			map[string]any{"role": "assistant", "content": "", "tool_calls": []any{map[string]any{"id": "toolu_missing", "function": map[string]any{"name": "read", "arguments": `{"path":"a.txt"}`}}}},
			map[string]any{"role": "user", "content": "ignore that"},
		},
	})

	state := payload["conversationState"].(map[string]any)
	history := state["history"].([]any)
	assistant := history[1].(map[string]any)["assistantResponseMessage"].(map[string]any)
	if _, ok := assistant["toolUses"]; ok {
		t.Fatalf("assistant retained orphaned toolUses: %#v", assistant)
	}
}

func TestKiroBuildRequestDoesNotInjectThinkingIntoToolResults(t *testing.T) {
	provider := kiroProvider{}
	payload := provider.buildRequest(map[string]any{
		"model":             "kiro/unit-test-model",
		"_includeReasoning": true,
		"messages": []any{
			map[string]any{"role": "system", "content": "follow policy"},
			map[string]any{"role": "assistant", "content": "", "tool_calls": []any{map[string]any{"id": "toolu_1", "function": map[string]any{"name": "read", "arguments": `{"path":"a.txt"}`}}}},
			map[string]any{"role": "tool", "tool_call_id": "toolu_1", "content": "file contents"},
		},
	})

	state := payload["conversationState"].(map[string]any)
	current := state["currentMessage"].(map[string]any)["userInputMessage"].(map[string]any)
	if strings.Contains(current["content"].(string), "<thinking_mode>") {
		t.Fatalf("current tool-result content contains thinking tags: %q", current["content"])
	}
	if current["content"] != "Tool results provided." {
		t.Fatalf("current content = %#v, want tool-result placeholder", current["content"])
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

func TestKiroBuildRequestUsesReasoningBudget(t *testing.T) {
	provider := kiroProvider{}
	payload := provider.buildRequest(map[string]any{
		"model": "kiro/unit-test-model",
		"reasoning": map[string]any{
			"budget_tokens": 4321,
		},
		"messages": []any{map[string]any{"role": "user", "content": "hello"}},
	})

	state := payload["conversationState"].(map[string]any)
	current := state["currentMessage"].(map[string]any)["userInputMessage"].(map[string]any)
	content := current["content"].(string)
	if !strings.Contains(content, "<thinking_mode>enabled</thinking_mode><max_thinking_length>4321</max_thinking_length>") {
		t.Fatalf("current content missing reasoning budget: %q", content)
	}
}

func TestKiroBuildRequestMapsReasoningEffortLikeOtherProviders(t *testing.T) {
	provider := kiroProvider{}
	payload := provider.buildRequest(map[string]any{
		"model":            "kiro/unit-test-model",
		"reasoning_effort": "low",
		"messages":         []any{map[string]any{"role": "user", "content": "hello"}},
	})

	state := payload["conversationState"].(map[string]any)
	current := state["currentMessage"].(map[string]any)["userInputMessage"].(map[string]any)
	content := current["content"].(string)
	if !strings.Contains(content, "<thinking_mode>enabled</thinking_mode><max_thinking_length>1024</max_thinking_length>") {
		t.Fatalf("current content missing low effort budget: %q", content)
	}
}

func TestKiroBuildRequestInjectsThinkingForOpus47(t *testing.T) {
	provider := kiroProvider{}
	payload := provider.buildRequest(map[string]any{
		"model":            "claude-opus-4-7",
		"reasoning_effort": "xhigh",
		"messages":         []any{map[string]any{"role": "user", "content": "hello"}},
	})

	state := payload["conversationState"].(map[string]any)
	current := state["currentMessage"].(map[string]any)["userInputMessage"].(map[string]any)
	if !strings.Contains(current["content"].(string), "<thinking_mode>enabled</thinking_mode><max_thinking_length>32000</max_thinking_length>") {
		t.Fatalf("current content missing thinking tags: %q", current["content"])
	}
}

func TestKiroBuildRequestReasoningEffortNoneDisablesThinking(t *testing.T) {
	provider := kiroProvider{}
	payload := provider.buildRequest(map[string]any{
		"model":            "kiro/unit-test-model",
		"reasoning_effort": "none",
		"messages":         []any{map[string]any{"role": "user", "content": "hello"}},
	})

	state := payload["conversationState"].(map[string]any)
	current := state["currentMessage"].(map[string]any)["userInputMessage"].(map[string]any)
	if strings.Contains(current["content"].(string), "<thinking_mode>") {
		t.Fatalf("current content contains thinking tags: %q", current["content"])
	}
}

func TestKiroBuildRequestIncludeThoughtsFalseDisablesThinking(t *testing.T) {
	provider := kiroProvider{}
	payload := provider.buildRequest(map[string]any{
		"model":             "kiro/unit-test-model",
		"_includeReasoning": true,
		"include_thoughts":  false,
		"messages":          []any{map[string]any{"role": "user", "content": "hello"}},
	})

	state := payload["conversationState"].(map[string]any)
	current := state["currentMessage"].(map[string]any)["userInputMessage"].(map[string]any)
	if strings.Contains(current["content"].(string), "<thinking_mode>") {
		t.Fatalf("current content contains thinking tags: %q", current["content"])
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

func TestKiroCompletionExtractsReasoningContentEvent(t *testing.T) {
	events := parseKiroJSONEvents(`{"reasoningContentEvent":{"text":"plan","signature":"sig"}}{"content":"answer"}`, &kiroParserState{})
	if len(events) != 2 {
		t.Fatalf("events len = %d, want 2: %#v", len(events), events)
	}
	completion := convertKiroEventsToCompletion(events, "unit-test-model")
	choice := completion["choices"].([]any)[0].(map[string]any)
	message := choice["message"].(map[string]any)
	if message["content"] != "answer" || message["reasoning_content"] != "plan" {
		t.Fatalf("message = %#v", message)
	}
}

func TestKiroCompletionExtractsDirectReasoningContentEvent(t *testing.T) {
	events := parseKiroJSONEvents(`{"text":"plan","signature":"sig"}{"content":"answer"}`, &kiroParserState{})
	if len(events) != 2 {
		t.Fatalf("events len = %d, want 2: %#v", len(events), events)
	}
	completion := convertKiroEventsToCompletion(events, "unit-test-model")
	choice := completion["choices"].([]any)[0].(map[string]any)
	message := choice["message"].(map[string]any)
	if message["content"] != "answer" || message["reasoning_content"] != "plan" {
		t.Fatalf("message = %#v", message)
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

func TestKiroSSEReaderExtractsReasoningContent(t *testing.T) {
	reader := newKiroSSEReader(strings.NewReader(`{"content":"<thinking>plan</thinking>\n\nanswer"}{"stop":true}`), "unit-test-model")
	out, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	text := string(out)
	if !strings.Contains(text, `"reasoning_content":"plan"`) {
		t.Fatalf("missing reasoning chunk: %s", text)
	}
	if !strings.Contains(text, `"content":"answer"`) {
		t.Fatalf("missing answer content chunk: %s", text)
	}
}

func TestKiroSSEReaderExtractsReasoningContentEvent(t *testing.T) {
	reader := newKiroSSEReader(strings.NewReader(`{"reasoningContentEvent":{"text":"plan","signature":"sig"}}{"content":"answer"}{"stop":true}`), "unit-test-model")
	out, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	text := string(out)
	if !strings.Contains(text, `"reasoning_content":"plan"`) {
		t.Fatalf("missing reasoning event chunk: %s", text)
	}
	if !strings.Contains(text, `"content":"answer"`) {
		t.Fatalf("missing answer content chunk: %s", text)
	}
}

func TestKiroSSEReaderPreservesUTF8AcrossReadBoundaries(t *testing.T) {
	reader := newKiroSSEReader(&oneByteReader{data: []byte(`{"content":"project` + "\u2014" + `like"}{"stop":true}`)}, "unit-test-model")
	out, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	text := string(out)
	if strings.Contains(text, "\ufffd") {
		t.Fatalf("stream contained replacement characters: %s", text)
	}
	if !strings.Contains(text, "proj") || !strings.Contains(text, "ect"+"\u2014"+"like") {
		t.Fatalf("missing preserved UTF-8 content: %s", text)
	}
}

func TestKiroAPIURLUsesProfileARNRegion(t *testing.T) {
	profileArn := "arn:aws:codecatalyst:eu-west-1:123456789012:space/test"
	got := kiroAPIURLForAccount(appdb.ProviderAccount{AccountID: &profileArn})
	if got != "https://q.eu-west-1.amazonaws.com/generateAssistantResponse" {
		t.Fatalf("url = %q", got)
	}
}
