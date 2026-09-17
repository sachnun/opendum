package providers

import "testing"

func TestDataURIToGeminiPart(t *testing.T) {
	t.Parallel()
	part := dataURIToGeminiPart("data:image/png;base64,QUJD")
	if part == nil {
		t.Fatal("valid data URI returned nil")
	}
	inline, _ := part["inlineData"].(map[string]any)
	if inline["mimeType"] != "image/png" || inline["data"] != "QUJD" {
		t.Fatalf("inlineData = %v", inline)
	}

	noType := dataURIToGeminiPart("data:;base64,QUJD")
	inline, _ = noType["inlineData"].(map[string]any)
	if inline["mimeType"] != "image/png" {
		t.Fatalf("default mimeType = %v, want image/png", inline["mimeType"])
	}

	for _, invalid := range []string{"https://x/y.png", "data:no-comma", ""} {
		if got := dataURIToGeminiPart(invalid); got != nil {
			t.Errorf("dataURIToGeminiPart(%q) = %v, want nil", invalid, got)
		}
	}
}

func TestUnwrapGeminiResponse(t *testing.T) {
	t.Parallel()
	if got := unwrapGeminiResponse(map[string]any{"response": map[string]any{"a": 1}}); got["a"] != 1 {
		t.Fatalf("wrapped map = %v", got)
	}
	if got := unwrapGeminiResponse(map[string]any{"b": 2}); got["b"] != 2 {
		t.Fatalf("plain map = %v", got)
	}
	if got := unwrapGeminiResponse([]any{map[string]any{"response": map[string]any{"c": 3}}}); got["c"] != 3 {
		t.Fatalf("array wrapped = %v", got)
	}
	if got := unwrapGeminiResponse([]any{}); len(got) != 0 {
		t.Fatalf("empty array = %v, want empty map", got)
	}
}

func TestSanitizedToolName(t *testing.T) {
	t.Parallel()
	if got := sanitizedToolName("1abc"); got != "t_1abc" {
		t.Fatalf("leading digit = %q, want t_1abc", got)
	}
	if got := sanitizedToolName("abc"); got != "abc" {
		t.Fatalf("valid = %q, want abc", got)
	}
	if got := sanitizedToolName(""); got != "" {
		t.Fatalf("empty = %q, want empty", got)
	}
}

func TestBestSchemaUnionOption(t *testing.T) {
	t.Parallel()
	options := []map[string]any{
		{"type": "null"},
		{"type": "string"},
		{"type": "object", "properties": map[string]any{"a": map[string]any{"type": "string"}}},
	}
	best := bestSchemaUnionOption(options)
	if best["type"] != "object" {
		t.Fatalf("best = %v, want object option", best)
	}

	allNull := bestSchemaUnionOption([]map[string]any{{"type": "null"}, {"type": "null"}})
	if allNull["type"] != "null" {
		t.Fatalf("all null = %v, want fallback to first option", allNull)
	}

	if got := bestSchemaUnionOption(nil); len(got) != 0 {
		t.Fatalf("empty = %v, want empty map", got)
	}
}

func TestKiroToolResultsFromContent(t *testing.T) {
	t.Parallel()
	content := []any{
		map[string]any{"type": "tool_result", "tool_use_id": "id1", "content": "hello"},
		map[string]any{"type": "text", "text": "ignored"},
		map[string]any{"type": "tool_result", "tool_call_id": "id2", "content": []any{map[string]any{"text": "world"}}},
		map[string]any{"type": "tool_result", "content": "no id"},
	}
	results := kiroToolResultsFromContent(content)
	if len(results) != 2 {
		t.Fatalf("len = %d, want 2", len(results))
	}
	first, _ := results[0].(map[string]any)
	if first["toolUseId"] != "id1" || first["status"] != "success" {
		t.Fatalf("first result = %v", first)
	}
	if text := kiroToolResultText(first); text != "hello" {
		t.Fatalf("first text = %q, want hello", text)
	}
	second, _ := results[1].(map[string]any)
	if second["toolUseId"] != "id2" || kiroToolResultText(second) != "world" {
		t.Fatalf("second result = %v", second)
	}

	if got := kiroToolResultsFromContent("not-a-slice"); got != nil {
		t.Fatalf("non-slice = %v, want nil", got)
	}
}

func TestFindOriginalKiroToolCall(t *testing.T) {
	t.Parallel()
	messages := []any{
		map[string]any{"role": "user", "content": "hi"},
		map[string]any{"role": "assistant", "tool_calls": []any{
			map[string]any{"id": "id1", "function": map[string]any{"name": "foo", "arguments": `{"a":1}`}},
		}},
		map[string]any{"role": "assistant", "content": []any{
			map[string]any{"type": "tool_use", "id": "id2", "name": "bar", "input": map[string]any{"b": 2}},
		}},
	}

	first := findOriginalKiroToolCall(messages, "id1")
	if first == nil || first["toolUseId"] != "id1" || first["name"] != "foo" {
		t.Fatalf("id1 = %v", first)
	}
	if input, _ := first["input"].(map[string]any); input["a"] != float64(1) {
		t.Fatalf("id1 input = %v", first["input"])
	}

	second := findOriginalKiroToolCall(messages, "id2")
	if second == nil || second["name"] != "bar" {
		t.Fatalf("id2 = %v", second)
	}
	if input, _ := second["input"].(map[string]any); input["b"] != 2 {
		t.Fatalf("id2 input = %v", second["input"])
	}

	if got := findOriginalKiroToolCall(messages, "missing"); got != nil {
		t.Fatalf("missing = %v, want nil", got)
	}
}

func TestKiroHistoryItemHasAssistant(t *testing.T) {
	t.Parallel()
	if !kiroHistoryItemHasAssistant(map[string]any{"assistantResponseMessage": map[string]any{}}) {
		t.Fatal("assistant item not detected")
	}
	if kiroHistoryItemHasAssistant(map[string]any{"userInputMessage": map[string]any{}}) {
		t.Fatal("user item misdetected as assistant")
	}
	if kiroHistoryItemHasAssistant(nil) {
		t.Fatal("nil misdetected as assistant")
	}
}
