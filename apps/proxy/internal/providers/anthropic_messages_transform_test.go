package providers

import (
	"context"
	"io"
	"strings"
	"testing"
)

func TestBuildAnthropicMessagesPayloadConvertsChat(t *testing.T) {
	body := map[string]any{
		"messages": []any{
			map[string]any{"role": "system", "content": "be brief"},
			map[string]any{"role": "user", "content": "hi"},
			map[string]any{"role": "assistant", "tool_calls": []any{map[string]any{"id": "call_1", "type": "function", "function": map[string]any{"name": "get_weather", "arguments": `{"city":"Paris"}`}}}},
			map[string]any{"role": "tool", "tool_call_id": "call_1", "content": "22C"},
		},
		"max_tokens":  512,
		"tools":       []any{map[string]any{"type": "function", "function": map[string]any{"name": "get_weather", "description": "weather", "parameters": map[string]any{"type": "object"}}}},
		"tool_choice": "required",
	}

	payload := buildAnthropicMessagesPayload(context.Background(), nil, body, "union-alpha", true)

	if payload["model"] != "union-alpha" || payload["stream"] != true || numberFromAny(payload["max_tokens"]) != 512 {
		t.Fatalf("payload header = %#v", payload)
	}
	if payload["system"] != "be brief" {
		t.Fatalf("system = %v, want be brief", payload["system"])
	}
	messages, _ := payload["messages"].([]any)
	if len(messages) != 3 {
		t.Fatalf("messages = %#v, want 3", messages)
	}
	assistant, _ := messages[1].(map[string]any)
	blocks, _ := assistant["content"].([]any)
	toolUse, _ := blocks[0].(map[string]any)
	if toolUse["type"] != "tool_use" || toolUse["name"] != "get_weather" {
		t.Fatalf("assistant block = %#v", toolUse)
	}
	toolResultMsg, _ := messages[2].(map[string]any)
	resultBlocks, _ := toolResultMsg["content"].([]any)
	toolResult, _ := resultBlocks[0].(map[string]any)
	if toolResult["type"] != "tool_result" || toolResult["tool_use_id"] != "call_1" || toolResult["content"] != "22C" {
		t.Fatalf("tool result = %#v", toolResult)
	}
	choice, _ := payload["tool_choice"].(map[string]any)
	if choice["type"] != "any" {
		t.Fatalf("tool_choice = %#v, want any", choice)
	}
}

func TestAnthropicMessagesToChatCompletionConvertsResponse(t *testing.T) {
	data := map[string]any{
		"id":          "msg_1",
		"model":       "union-alpha",
		"stop_reason": "tool_use",
		"content": []any{
			map[string]any{"type": "text", "text": "thinking out loud"},
			map[string]any{"type": "tool_use", "id": "toolu_1", "name": "get_weather", "input": map[string]any{"city": "Paris"}},
		},
		"usage": map[string]any{"input_tokens": 11, "output_tokens": 3, "cache_read_input_tokens": 5},
	}

	completion := anthropicMessagesToChatCompletion(data, "union-alpha")
	choices, _ := completion["choices"].([]any)
	choice, _ := choices[0].(map[string]any)
	message, _ := choice["message"].(map[string]any)
	if message["content"] != "thinking out loud" {
		t.Fatalf("content = %v", message["content"])
	}
	calls, _ := message["tool_calls"].([]any)
	call, _ := calls[0].(map[string]any)
	fn, _ := call["function"].(map[string]any)
	if fn["name"] != "get_weather" || fn["arguments"] != `{"city":"Paris"}` {
		t.Fatalf("tool call = %#v", call)
	}
	if choice["finish_reason"] != "tool_calls" {
		t.Fatalf("finish = %v", choice["finish_reason"])
	}
	usage, _ := completion["usage"].(map[string]any)
	if numberFromAny(usage["prompt_tokens"]) != 11 || numberFromAny(usage["completion_tokens"]) != 3 {
		t.Fatalf("usage = %#v", usage)
	}
	details, _ := usage["prompt_tokens_details"].(map[string]any)
	if numberFromAny(details["cached_tokens"]) != 5 {
		t.Fatalf("cached = %#v", details)
	}
}

func TestAnthropicMessagesSSEToChatSSE(t *testing.T) {
	source := strings.Join([]string{
		"event: message_start",
		`data: {"type":"message_start","message":{"id":"msg_1","model":"union-alpha","usage":{"input_tokens":1,"output_tokens":0}}}`,
		"",
		"event: content_block_start",
		`data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
		"",
		"event: content_block_delta",
		`data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}`,
		"",
		"event: content_block_start",
		`data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_weather","input":{}}}`,
		"",
		"event: content_block_delta",
		`data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"city\":\"Paris\"}"}}`,
		"",
		"event: message_delta",
		`data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"input_tokens":7,"output_tokens":4}}`,
		"",
		"event: message_stop",
		`data: {"type":"message_stop"}`,
		"",
	}, "\n")

	out, err := io.ReadAll(anthropicMessagesSSEToChatSSEReader(strings.NewReader(source), "union-alpha"))
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	text := string(out)
	for _, want := range []string{`"content":"Hi"`, `"name":"get_weather"`, `"arguments":"{\"city\":\"Paris\"}"`, `"finish_reason":"tool_calls"`, "data: [DONE]"} {
		if !strings.Contains(text, want) {
			t.Fatalf("output missing %q:\n%s", want, text)
		}
	}
}
