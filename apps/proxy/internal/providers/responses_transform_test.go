package providers

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestNormalizeResponsesInputInfersItemType(t *testing.T) {
	input := []any{
		map[string]any{"role": "developer", "content": "be brief"},
		map[string]any{"role": "user", "content": []any{map[string]any{"type": "input_text", "text": "hi"}}},
		map[string]any{"summary": []any{map[string]any{"type": "summary_text", "text": "thought"}}},
		map[string]any{"call_id": "fc_1", "name": "get_weather", "arguments": "{}"},
		map[string]any{"call_id": "fc_1", "output": "22C"},
	}

	out := normalizeResponsesInput(input)
	if len(out) != len(input) {
		t.Fatalf("len(out) = %d, want %d", len(out), len(input))
	}

	wantTypes := []string{"message", "message", "reasoning", "function_call", "function_call_output"}
	for i, want := range wantTypes {
		item, _ := out[i].(map[string]any)
		if got := stringValue(item["type"]); got != want {
			t.Fatalf("out[%d].type = %q, want %q", i, got, want)
		}
	}

	message, _ := out[0].(map[string]any)
	if message["role"] != "developer" {
		t.Fatalf("role = %v, want developer", message["role"])
	}

	userMessage, _ := out[1].(map[string]any)
	parts, _ := userMessage["content"].([]any)
	if len(parts) != 1 {
		t.Fatalf("content parts = %#v, want 1 part", userMessage["content"])
	}
	part, _ := parts[0].(map[string]any)
	if part["type"] != "input_text" {
		t.Fatalf("content part type = %v, want input_text", part["type"])
	}

	call, _ := out[3].(map[string]any)
	if call["id"] != "fc_1" || call["call_id"] != "fc_1" {
		t.Fatalf("function_call ids = %v/%v, want fc_1/fc_1", call["id"], call["call_id"])
	}
}

func TestNormalizeResponsesInputPreservesExplicitType(t *testing.T) {
	out := normalizeResponsesInput([]any{
		map[string]any{"type": "function_call", "id": "call_abc", "call_id": "call_abc", "name": "f", "arguments": "{}"},
	})
	item, _ := out[0].(map[string]any)
	if item["id"] != "fc_abc" || item["call_id"] != "fc_abc" {
		t.Fatalf("ids = %v/%v, want fc_abc/fc_abc", item["id"], item["call_id"])
	}
}

func TestTransformChatSSEToResponsesEmitsOrderedItems(t *testing.T) {
	upstream := strings.Join([]string{
		`data: {"choices":[{"index":0,"delta":{"reasoning_content":"think"},"finish_reason":null}]}`,
		"",
		`data: {"choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}`,
		"",
		`data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_weather","arguments":"{\"city\""}}]},"finish_reason":null}]}`,
		"",
		`data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\"Paris\"}"}}]},"finish_reason":null}]}`,
		"",
		`data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":4},"completion_tokens_details":{"reasoning_tokens":3}}}`,
		"",
		"data: [DONE]",
		"",
	}, "\n")

	var builder strings.Builder
	transformChatSSEToResponses(strings.NewReader(upstream), &builder, "test-model")

	events := decodeSSEEvents(t, builder.String())
	if len(events) == 0 {
		t.Fatal("no events emitted")
	}
	if events[0]["type"] != "response.created" {
		t.Fatalf("first event type = %v, want response.created", events[0]["type"])
	}

	sequence := make([]string, 0, len(events))
	for _, event := range events {
		sequence = append(sequence, stringValue(event["type"]))
	}

	addedIndexes := []float64{}
	for _, event := range events {
		if event["type"] != "response.output_item.added" {
			continue
		}
		addedIndexes = append(addedIndexes, float64(numberFromAny(event["output_index"])))
	}
	if len(addedIndexes) != 3 {
		t.Fatalf("output_item.added count = %d, want 3 (%v)", len(addedIndexes), sequence)
	}
	for i, index := range addedIndexes {
		if int(index) != i {
			t.Fatalf("output_item.added[%d] output_index = %v, want %d", i, index, i)
		}
	}

	last := events[len(events)-1]
	if last["type"] != "response.completed" {
		t.Fatalf("last event type = %v, want response.completed", last["type"])
	}
	response, _ := last["response"].(map[string]any)
	output, _ := response["output"].([]any)
	if len(output) != 3 {
		t.Fatalf("output items = %d, want 3", len(output))
	}

	reasoning, _ := output[0].(map[string]any)
	if reasoning["type"] != "reasoning" {
		t.Fatalf("output[0].type = %v, want reasoning", reasoning["type"])
	}
	summary, _ := reasoning["summary"].([]any)
	if len(summary) != 1 {
		t.Fatalf("reasoning summary = %#v, want 1 entry", reasoning["summary"])
	}
	summaryPart, _ := summary[0].(map[string]any)
	if summaryPart["type"] != "summary_text" || summaryPart["text"] != "think" {
		t.Fatalf("summary part = %#v, want summary_text/think", summaryPart)
	}

	message, _ := output[1].(map[string]any)
	if message["type"] != "message" {
		t.Fatalf("output[1].type = %v, want message", message["type"])
	}
	parts, _ := message["content"].([]any)
	part, _ := parts[0].(map[string]any)
	if part["type"] != "output_text" || part["text"] != "hello" {
		t.Fatalf("message content part = %#v, want output_text/hello", part)
	}
	if _, ok := part["annotations"]; !ok {
		t.Fatalf("message content part missing annotations: %#v", part)
	}

	call, _ := output[2].(map[string]any)
	if call["type"] != "function_call" {
		t.Fatalf("output[2].type = %v, want function_call", call["type"])
	}
	if call["call_id"] != "fc_1" || call["name"] != "get_weather" {
		t.Fatalf("function_call = %#v, want fc_1/get_weather", call)
	}
	if call["arguments"] != `{"city":"Paris"}` {
		t.Fatalf("arguments = %v, want {\"city\":\"Paris\"}", call["arguments"])
	}

	usage, _ := response["usage"].(map[string]any)
	if numberFromAny(usage["input_tokens"]) != 10 || numberFromAny(usage["output_tokens"]) != 5 {
		t.Fatalf("usage = %#v, want 10/5", usage)
	}
	inputDetails, _ := usage["input_tokens_details"].(map[string]any)
	if numberFromAny(inputDetails["cached_tokens"]) != 4 {
		t.Fatalf("cached_tokens = %v, want 4", inputDetails["cached_tokens"])
	}
	outputDetails, _ := usage["output_tokens_details"].(map[string]any)
	if numberFromAny(outputDetails["reasoning_tokens"]) != 3 {
		t.Fatalf("reasoning_tokens = %v, want 3", outputDetails["reasoning_tokens"])
	}
}

func TestTransformChatSSEToResponsesMarksLengthStopIncomplete(t *testing.T) {
	upstream := strings.Join([]string{
		`data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}`,
		"",
		`data: {"choices":[{"index":0,"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":1,"completion_tokens":2}}`,
		"",
		"data: [DONE]",
		"",
	}, "\n")

	var builder strings.Builder
	transformChatSSEToResponses(strings.NewReader(upstream), &builder, "test-model")

	events := decodeSSEEvents(t, builder.String())
	last := events[len(events)-1]
	if last["type"] != "response.incomplete" {
		t.Fatalf("last event type = %v, want response.incomplete", last["type"])
	}
	response, _ := last["response"].(map[string]any)
	if response["status"] != "incomplete" {
		t.Fatalf("status = %v, want incomplete", response["status"])
	}
	details, _ := response["incomplete_details"].(map[string]any)
	if details["reason"] != "max_output_tokens" {
		t.Fatalf("incomplete_details = %#v, want max_output_tokens", details)
	}
}

func TestChatCompletionToResponsesJSONUsesResponsesShape(t *testing.T) {
	response := chatCompletionToResponsesJSON(map[string]any{
		"id": "chatcmpl_1",
		"choices": []any{map[string]any{
			"message": map[string]any{
				"content":           "hi",
				"reasoning_content": "think",
				"tool_calls": []any{map[string]any{
					"id":       "call_1",
					"function": map[string]any{"name": "f", "arguments": "{}"},
				}},
			},
			"finish_reason": "tool_calls",
		}},
		"usage": map[string]any{"prompt_tokens": 7, "completion_tokens": 3},
	}, "m")

	if response["object"] != "response" {
		t.Fatalf("object = %v, want response", response["object"])
	}
	output, _ := response["output"].([]any)
	if len(output) != 3 {
		t.Fatalf("output items = %d, want 3", len(output))
	}
	reasoning, _ := output[0].(map[string]any)
	summary, _ := reasoning["summary"].([]any)
	part, _ := summary[0].(map[string]any)
	if part["text"] != "think" {
		t.Fatalf("reasoning text = %v, want think", part["text"])
	}
	call, _ := output[2].(map[string]any)
	if call["call_id"] != "fc_1" {
		t.Fatalf("call_id = %v, want fc_1", call["call_id"])
	}
	usage, _ := response["usage"].(map[string]any)
	if numberFromAny(usage["total_tokens"]) != 10 {
		t.Fatalf("total_tokens = %v, want 10", usage["total_tokens"])
	}
}

func decodeSSEEvents(t *testing.T, payload string) []map[string]any {
	t.Helper()
	events := []map[string]any{}
	for _, block := range strings.Split(payload, "\n\n") {
		block = strings.TrimSpace(block)
		if block == "" {
			continue
		}
		for _, line := range strings.Split(block, "\n") {
			if !strings.HasPrefix(line, "data:") {
				continue
			}
			data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
			if data == "" || data == "[DONE]" {
				continue
			}
			var event map[string]any
			if err := json.Unmarshal([]byte(data), &event); err != nil {
				t.Fatalf("invalid SSE payload %q: %v", data, err)
			}
			events = append(events, event)
		}
	}
	return events
}
