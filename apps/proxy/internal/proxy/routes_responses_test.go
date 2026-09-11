package proxy

import (
	"testing"
)

func TestConvertResponsesInputInfersMessageType(t *testing.T) {
	messages := convertResponsesInputToMessages([]any{
		map[string]any{"role": "developer", "content": "be brief"},
		map[string]any{"role": "user", "content": "hello"},
	}, "")

	if len(messages) != 2 {
		t.Fatalf("messages = %#v, want 2", messages)
	}
	first, _ := messages[0].(map[string]any)
	if first["role"] != "system" || first["content"] != "be brief" {
		t.Fatalf("messages[0] = %#v, want system/be brief", first)
	}
	second, _ := messages[1].(map[string]any)
	if second["role"] != "user" || second["content"] != "hello" {
		t.Fatalf("messages[1] = %#v, want user/hello", second)
	}
}

func TestConvertResponsesInputAttachesReasoningToAssistantTurn(t *testing.T) {
	messages := convertResponsesInputToMessages([]any{
		map[string]any{"role": "user", "content": "weather?"},
		map[string]any{"type": "reasoning", "summary": []any{map[string]any{"type": "summary_text", "text": "check the tool"}}},
		map[string]any{"type": "function_call", "call_id": "call_1", "name": "get_weather", "arguments": "{\"city\":\"Paris\"}"},
		map[string]any{"type": "function_call_output", "call_id": "call_1", "output": "22C"},
	}, "")

	if len(messages) != 3 {
		t.Fatalf("messages = %#v, want 3", messages)
	}
	assistant, _ := messages[1].(map[string]any)
	if assistant["role"] != "assistant" {
		t.Fatalf("messages[1].role = %v, want assistant", assistant["role"])
	}
	if assistant["reasoning_content"] != "check the tool" {
		t.Fatalf("reasoning_content = %v, want %q", assistant["reasoning_content"], "check the tool")
	}
	calls, _ := assistant["tool_calls"].([]any)
	if len(calls) != 1 {
		t.Fatalf("tool_calls = %#v, want 1", assistant["tool_calls"])
	}
	call, _ := calls[0].(map[string]any)
	if call["id"] != "call_1" {
		t.Fatalf("tool call id = %v, want call_1", call["id"])
	}
	toolMessage, _ := messages[2].(map[string]any)
	if toolMessage["role"] != "tool" || toolMessage["tool_call_id"] != "call_1" {
		t.Fatalf("messages[2] = %#v, want tool/call_1", toolMessage)
	}
}

func TestConvertResponsesInputAcceptsReasoningWithoutType(t *testing.T) {
	messages := convertResponsesInputToMessages([]any{
		map[string]any{"summary": []any{map[string]any{"text": "no type field"}}},
		map[string]any{"role": "assistant", "content": "done"},
	}, "")

	if len(messages) != 1 {
		t.Fatalf("messages = %#v, want 1", messages)
	}
	assistant, _ := messages[0].(map[string]any)
	if assistant["reasoning_content"] != "no type field" {
		t.Fatalf("reasoning_content = %v, want %q", assistant["reasoning_content"], "no type field")
	}
	if assistant["content"] != "done" {
		t.Fatalf("content = %v, want done", assistant["content"])
	}
}

func TestConvertResponsesInputReadsReasoningContent(t *testing.T) {
	messages := convertResponsesInputToMessages([]any{
		map[string]any{"type": "reasoning", "content": []any{map[string]any{"type": "reasoning_text", "text": "step one"}}},
		map[string]any{"type": "function_call", "call_id": "fc_1", "name": "f", "arguments": "{}"},
	}, "")

	assistant, _ := messages[0].(map[string]any)
	if assistant["reasoning_content"] != "step one" {
		t.Fatalf("reasoning_content = %v, want %q", assistant["reasoning_content"], "step one")
	}
}

func TestConvertResponsesInputHandlesStructuredToolOutput(t *testing.T) {
	messages := convertResponsesInputToMessages([]any{
		map[string]any{"type": "function_call", "call_id": "fc_1", "name": "f", "arguments": "{}"},
		map[string]any{"type": "function_call_output", "call_id": "fc_1", "output": []any{
			map[string]any{"type": "output_text", "text": "line one"},
			map[string]any{"type": "output_text", "text": "line two"},
		}},
	}, "")

	toolMessage, _ := messages[1].(map[string]any)
	if toolMessage["content"] != "line one\nline two" {
		t.Fatalf("content = %v, want joined text", toolMessage["content"])
	}
}

func TestConvertResponsesInputKeepsInstructionPrefix(t *testing.T) {
	messages := convertResponsesInputToMessages([]any{
		map[string]any{"role": "user", "content": "hi"},
	}, "system prompt")

	if len(messages) != 2 {
		t.Fatalf("messages = %#v, want 2", messages)
	}
	system, _ := messages[0].(map[string]any)
	if system["role"] != "system" || system["content"] != "system prompt" {
		t.Fatalf("messages[0] = %#v, want system/system prompt", system)
	}
}
