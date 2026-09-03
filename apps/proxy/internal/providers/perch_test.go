package providers

import (
	"encoding/json"
	"strings"
	"testing"
)

func perchEvent(payload map[string]any) string {
	data, _ := json.Marshal(payload)
	return "data: " + string(data)
}

func perchSSE(events ...map[string]any) string {
	lines := make([]string, 0, len(events)+1)
	for _, event := range events {
		lines = append(lines, perchEvent(event))
	}
	lines = append(lines, "data: [DONE]")
	return strings.Join(lines, "\n\n") + "\n\n"
}

func perchReadSSE(t *testing.T, sse string, includeReasoning bool) string {
	t.Helper()
	reader := perchSSEToChatSSEReader(strings.NewReader(sse), "glm-5", includeReasoning)
	var out strings.Builder
	buf := make([]byte, 4096)
	for {
		n, err := reader.Read(buf)
		out.Write(buf[:n])
		if err != nil {
			break
		}
	}
	return out.String()
}

func perchDeltaText(chunk map[string]any) string {
	choices, _ := chunk["choices"].([]any)
	if len(choices) == 0 {
		return ""
	}
	delta, _ := choices[0].(map[string]any)["delta"].(map[string]any)
	if delta == nil {
		return ""
	}
	text, _ := delta["content"].(string)
	return text
}

func TestPerchModelOptionIDResolvesPoolAliases(t *testing.T) {
	cases := map[string]string{
		"qwen-3.6":        "wandb-qwen3-6-35b-a3b",
		"glm-5":           "bedrock-mantle-zai-glm-5",
		"kimi-2.5":        "bedrock-mantle-moonshotai-kimi-k2-5",
		"minimax-m3-free": "gmi-minimaxai-minimax-m3",
		"unknown-model":   perchManualOptionIDs[perchFallbackAlias],
	}
	for alias, want := range cases {
		if got := perchModelOptionID(alias); got != want {
			t.Fatalf("perchModelOptionID(%q) = %q, want %q", alias, got, want)
		}
	}
}

func TestPerchMessagesRoundTripPreservesToolIDs(t *testing.T) {
	messages := perchMessages(map[string]any{
		"messages": []any{
			map[string]any{"role": "system", "content": "Be terse."},
			map[string]any{"role": "user", "content": "hi"},
			map[string]any{"role": "assistant", "content": "let me check", "tool_calls": []any{map[string]any{"id": "call_1", "type": "function", "function": map[string]any{"name": "search", "arguments": `{"q":"x"}`}}}},
			map[string]any{"role": "tool", "tool_call_id": "call_1", "content": []any{map[string]any{"type": "text", "text": "result"}}},
		},
	})
	if len(messages) != 4 {
		t.Fatalf("messages len = %d, got %#v", len(messages), messages)
	}
	system := messages[0].(map[string]any)
	if system["role"] != "system" || system["content"] != "Be terse." {
		t.Fatalf("system message = %#v", system)
	}
	assistant := messages[2].(map[string]any)
	calls := assistant["tool_calls"].([]any)
	call := calls[0].(map[string]any)
	if call["id"] != "call_1" {
		t.Fatalf("assistant tool id = %#v", call)
	}
	function := call["function"].(map[string]any)
	if function["name"] != "search" || function["arguments"] != `{"q":"x"}` {
		t.Fatalf("assistant function = %#v", function)
	}
	tool := messages[3].(map[string]any)
	if tool["role"] != "tool" || tool["tool_call_id"] != "call_1" || tool["content"] != "result" {
		t.Fatalf("tool message = %#v", tool)
	}
}

func TestPerchToolsSkipEmptyEntries(t *testing.T) {
	tools := perchTools(map[string]any{
		"tools": []any{
			map[string]any{"type": "function", "function": map[string]any{"name": "search", "description": "Search", "parameters": map[string]any{"type": "object"}}},
			map[string]any{"type": "function", "function": map[string]any{"name": "", "description": ""}},
		},
	})
	if tools == nil || len(tools) != 1 {
		t.Fatalf("tools = %#v", tools)
	}
	converted := tools[0].(map[string]any)
	fn := converted["function"].(map[string]any)
	if fn["name"] != "search" || fn["description"] != "Search" {
		t.Fatalf("converted tool = %#v", converted)
	}
	if _, ok := fn["parameters"].(map[string]any); !ok {
		t.Fatalf("parameters missing: %#v", converted)
	}
	if perchTools(map[string]any{}) != nil {
		t.Fatal("empty tools should map to nil")
	}
}

func TestPerchSSEToChatCompletionBuffersTextToolsAndUsage(t *testing.T) {
	events := []map[string]any{
		{"type": "reasoning_delta", "text": "thinking..."},
		{"type": "answer_delta", "text": "Hello"},
		{"type": "answer_delta", "text": " world"},
		{"type": "tool_call_delta", "toolCalls": []any{map[string]any{"id": "t_1", "name": "search", "rawArgumentsText": `{"q":"`}}},
		{"type": "tool_call_delta", "toolCalls": []any{map[string]any{"id": "t_1", "rawArgumentsText": `perch"}`}}},
		{"type": "tool_use_end", "toolCalls": []any{map[string]any{"id": "t_1", "name": "search", "arguments": map[string]any{"q": "perch"}}}},
		{"type": "done", "ok": true, "usage": map[string]any{"inputTokens": 10, "outputTokens": 5, "cacheReadInputTokens": 3}},
	}
	completion, err := perchSSEToChatCompletion(strings.NewReader(perchSSE(events...)), "glm-5", true)
	if err != nil {
		t.Fatal(err)
	}
	if completion["model"] != "glm-5" {
		t.Fatalf("model = %v", completion["model"])
	}
	message := completion["choices"].([]any)[0].(map[string]any)["message"].(map[string]any)
	if message["content"] != "Hello world" {
		t.Fatalf("content = %#v", message["content"])
	}
	if message["reasoning_content"] != "thinking..." {
		t.Fatalf("reasoning = %#v", message["reasoning_content"])
	}
	calls := message["tool_calls"].([]any)
	if len(calls) != 1 {
		t.Fatalf("tool_calls = %#v", message["tool_calls"])
	}
	call := calls[0].(map[string]any)
	if call["id"] != "t_1" {
		t.Fatalf("tool call id = %#v", call)
	}
	fn := call["function"].(map[string]any)
	if fn["name"] != "search" || fn["arguments"] != `{"q":"perch"}` {
		t.Fatalf("tool function = %#v", fn)
	}
	usage := completion["usage"].(map[string]any)
	if usage["prompt_tokens"] != 13 || usage["completion_tokens"] != 5 || usage["total_tokens"] != 18 {
		t.Fatalf("usage = %#v", usage)
	}
}

func TestPerchSSEStreamEmitsChatChunks(t *testing.T) {
	events := []map[string]any{
		{"type": "answer_delta", "text": "Hi"},
		{"type": "done", "ok": true, "usage": map[string]any{"inputTokens": 4, "outputTokens": 1}},
	}
	chunks := parseChatChunks(t, perchReadSSE(t, perchSSE(events...), false))
	text := ""
	for _, chunk := range chunks {
		text += perchDeltaText(chunk)
	}
	if text != "Hi" {
		t.Fatalf("streamed text = %q", text)
	}
	if len(chunks) < 3 {
		t.Fatalf("chunks = %d: %#v", len(chunks), chunks)
	}
	last := chunks[len(chunks)-1]
	choices := last["choices"].([]any)
	finish := choices[0].(map[string]any)["finish_reason"]
	if finish != "stop" {
		t.Fatalf("finish_reason = %#v", finish)
	}
}

func TestPerchSSEStreamFailureInjectsErrorMessage(t *testing.T) {
	events := []map[string]any{
		{"type": "answer_delta", "text": "partial"},
		{"type": "done", "ok": false, "error": "Monthly allowance reached"},
	}
	chunks := parseChatChunks(t, perchReadSSE(t, perchSSE(events...), false))
	text := ""
	for _, chunk := range chunks {
		text += perchDeltaText(chunk)
	}
	if text != "partialMonthly allowance reached" {
		t.Fatalf("streamed text = %q", text)
	}
}
