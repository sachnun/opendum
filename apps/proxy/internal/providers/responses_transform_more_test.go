package providers

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestToChatCallID(t *testing.T) {
	t.Parallel()
	if got := toChatCallID("call_abc"); got != "call_abc" {
		t.Fatalf("prefixed = %q, want call_abc", got)
	}
	if got := toChatCallID("fc_abc"); got != "call_abc" {
		t.Fatalf("fc_ = %q, want call_abc", got)
	}
	if got := toChatCallID("fc-abc"); got != "call_abc" {
		t.Fatalf("fc- = %q, want call_abc", got)
	}
	if got := toChatCallID("abc"); got != "call_abc" {
		t.Fatalf("bare = %q, want call_abc", got)
	}
	if got := toChatCallID(""); !strings.HasPrefix(got, "call_") {
		t.Fatalf("empty = %q, want call_ prefix", got)
	}
}

func TestToResponsesAPIID(t *testing.T) {
	t.Parallel()
	cases := map[string]string{
		"fc_abc":   "fc_abc",
		"fc-abc":   "fc-abc",
		"apc_abc":  "apc_abc",
		"call_abc": "fc_abc",
		"abc":      "fc_abc",
	}
	for input, want := range cases {
		if got := toResponsesAPIID(input); got != want {
			t.Errorf("toResponsesAPIID(%q) = %q, want %q", input, got, want)
		}
	}
	if got := toResponsesAPIID(""); !strings.HasPrefix(got, "fc") {
		t.Fatalf("empty = %q, want fc prefix", got)
	}
}

func TestResponseUsageToChatUsage(t *testing.T) {
	t.Parallel()
	responses := responseUsageToChatUsage(map[string]any{
		"input_tokens":          10,
		"output_tokens":         5,
		"input_tokens_details":  map[string]any{"cached_tokens": 3, "cache_write_tokens": 2},
		"output_tokens_details": map[string]any{"reasoning_tokens": 4},
	})
	if responses["prompt_tokens"] != 10 || responses["completion_tokens"] != 5 || responses["total_tokens"] != 15 {
		t.Fatalf("token counts = %v", responses)
	}
	promptDetails, _ := responses["prompt_tokens_details"].(map[string]any)
	if promptDetails["cached_tokens"] != 3 || promptDetails["cache_write_tokens"] != 2 {
		t.Fatalf("prompt details = %v", promptDetails)
	}
	completionDetails, _ := responses["completion_tokens_details"].(map[string]any)
	if completionDetails["reasoning_tokens"] != 4 {
		t.Fatalf("completion details = %v", completionDetails)
	}

	chat := responseUsageToChatUsage(map[string]any{
		"prompt_tokens":         7,
		"completion_tokens":     2,
		"prompt_tokens_details": map[string]any{"cached_tokens": 1},
	})
	if chat["prompt_tokens"] != 7 || chat["completion_tokens"] != 2 || chat["total_tokens"] != 9 {
		t.Fatalf("chat fallback counts = %v", chat)
	}
	if _, ok := chat["completion_tokens_details"]; ok {
		t.Fatalf("unexpected completion details = %v", chat)
	}

	empty := responseUsageToChatUsage(nil)
	if empty["prompt_tokens"] != 0 || empty["completion_tokens"] != 0 || empty["total_tokens"] != 0 {
		t.Fatalf("nil usage = %v", empty)
	}
	if _, ok := empty["prompt_tokens_details"]; ok {
		t.Fatalf("unexpected details for nil usage = %v", empty)
	}
}

func TestResponsesJSONToChatCompletion(t *testing.T) {
	t.Parallel()
	data := map[string]any{
		"status": "completed",
		"output": []any{
			map[string]any{"type": "reasoning", "summary": []any{"thinking"}},
			map[string]any{"type": "message", "content": []any{map[string]any{"type": "output_text", "text": "hello"}}},
			map[string]any{"type": "function_call", "call_id": "call_1", "name": "tool", "arguments": `{"a":1}`},
		},
		"usage": map[string]any{"input_tokens": 1, "output_tokens": 2},
	}
	result := responsesJSONToChatCompletion(data, "mock-model")
	choices, _ := result["choices"].([]any)
	if len(choices) != 1 {
		t.Fatalf("choices = %v", result["choices"])
	}
	choice, _ := choices[0].(map[string]any)
	if choice["finish_reason"] != "tool_calls" {
		t.Fatalf("finish_reason = %v, want tool_calls", choice["finish_reason"])
	}
	message, _ := choice["message"].(map[string]any)
	if message["content"] != "hello" || message["reasoning_content"] != "thinking" {
		t.Fatalf("message = %v", message)
	}
	calls, _ := message["tool_calls"].([]any)
	if len(calls) != 1 {
		t.Fatalf("tool_calls = %v", message["tool_calls"])
	}
	call, _ := calls[0].(map[string]any)
	if call["id"] != "call_1" {
		t.Fatalf("call id = %v, want call_1", call["id"])
	}
	fn, _ := call["function"].(map[string]any)
	if fn["name"] != "tool" || fn["arguments"] != `{"a":1}` {
		t.Fatalf("function = %v", fn)
	}

	blank := responsesJSONToChatCompletion(map[string]any{"status": "completed", "output": []any{}}, "mock-model")
	blankChoices, _ := blank["choices"].([]any)
	choice, _ = blankChoices[0].(map[string]any)
	if choice["finish_reason"] != "stop" {
		t.Fatalf("empty finish_reason = %v, want stop", choice["finish_reason"])
	}
	message, _ = choice["message"].(map[string]any)
	if message["content"] != nil {
		t.Fatalf("empty content = %v, want nil", message["content"])
	}
}

func TestExtractReasoningFromItem(t *testing.T) {
	t.Parallel()
	if got := extractReasoningFromItem(map[string]any{"summary": []any{"a", "b"}}); got != "a\n\nb" {
		t.Fatalf("summary = %q, want a\\n\\nb", got)
	}
	if got := extractReasoningFromItem(map[string]any{"content": []any{map[string]any{"text": "c"}}}); got != "c" {
		t.Fatalf("content = %q, want c", got)
	}
	if got := extractReasoningFromItem(map[string]any{"text": "d"}); got != "d" {
		t.Fatalf("text = %q, want d", got)
	}
	if got := extractReasoningFromItem(map[string]any{}); got != "" {
		t.Fatalf("empty = %q, want empty", got)
	}
}

func TestReasoningPartsDedupesIncrementalPrefix(t *testing.T) {
	t.Parallel()
	parts := newReasoningParts()
	first, isNew := parts.append("k", "hello")
	if first != "hello" || !isNew {
		t.Fatalf("first append = (%q, %v)", first, isNew)
	}
	growth, isNew := parts.append("k", "hello world")
	if growth != " world" || isNew {
		t.Fatalf("growth append = (%q, %v), want ( world, false)", growth, isNew)
	}
	if got, _ := parts.append("k", "hello world"); got != "" {
		t.Fatalf("duplicate append = %q, want empty", got)
	}
	other, isNew := parts.append("j", "second")
	if other != "second" || !isNew {
		t.Fatalf("new key append = (%q, %v)", other, isNew)
	}
	if got := parts.text(); got != "hello world\n\nsecond" {
		t.Fatalf("text = %q", got)
	}
}

func TestTransformResponsesSSEToChat(t *testing.T) {
	t.Parallel()
	source := strings.Join([]string{
		`data: {"type":"response.output_text.delta","delta":"Hel"}`,
		`data: {"type":"response.output_text.delta","delta":"lo"}`,
		`data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_1","name":"tool"}}`,
		`data: {"type":"response.function_call_arguments.delta","delta":"{\"a\""}`,
		`data: {"type":"response.function_call_arguments.done","arguments":"{\"a\":1}"}`,
		`data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":2}}}`,
		`data: [DONE]`,
	}, "\n\n")

	var out bytes.Buffer
	transformResponsesSSEToChat(strings.NewReader(source), &out, "mock-model")
	got := out.String()

	for _, want := range []string{
		`"object":"chat.completion.chunk"`,
		`"content":"Hel"`,
		`"content":"lo"`,
		`"tool_calls"`,
		`"call_1"`,
		`"finish_reason":"tool_calls"`,
		`"prompt_tokens":1`,
		`"completion_tokens":2`,
		`data: [DONE]`,
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("output missing %s\ngot: %s", want, got)
		}
	}
}

func TestResponsesStreamToCompletion(t *testing.T) {
	t.Parallel()
	source := strings.Join([]string{
		`data: {"type":"response.output_text.delta","delta":"Hi"}`,
		`data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":2}}}`,
	}, "\n\n")

	result := responsesStreamToCompletion(strings.NewReader(source), "mock-model")
	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	got := string(encoded)
	for _, want := range []string{`"object":"chat.completion"`, `"content":"Hi"`, `"prompt_tokens":1`, `"completion_tokens":2`} {
		if !strings.Contains(got, want) {
			t.Fatalf("result missing %s\ngot: %s", want, got)
		}
	}
}
