package providers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"

	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
)

func perchEvent(payload map[string]any) string {
	data, _ := json.Marshal(payload)
	return "data: " + string(data)
}

func parseChatChunks(t *testing.T, sse string) []map[string]any {
	t.Helper()
	chunks := []map[string]any{}
	for _, raw := range strings.Split(strings.TrimSpace(sse), "\n\n") {
		raw = strings.TrimSpace(raw)
		if raw == "" || raw == "data: [DONE]" {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(raw, "data:"))
		if payload == "[DONE]" {
			continue
		}
		var chunk map[string]any
		if err := json.Unmarshal([]byte(payload), &chunk); err != nil {
			t.Fatalf("parse chunk %q: %v", payload, err)
		}
		chunks = append(chunks, chunk)
	}
	return chunks
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
	}
	for alias, want := range cases {
		got, ok := perchModelOptionID(alias)
		if !ok || got != want {
			t.Fatalf("perchModelOptionID(%q) = %q, %v; want %q, true", alias, got, ok, want)
		}
	}
	if _, ok := perchModelOptionID("unknown-model"); ok {
		t.Fatal("unknown alias should not resolve to a pool option")
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

func perchToolDeltas(chunks []map[string]any) []map[string]any {
	out := []map[string]any{}
	for _, chunk := range chunks {
		choices, _ := chunk["choices"].([]any)
		if len(choices) == 0 {
			continue
		}
		delta, _ := choices[0].(map[string]any)["delta"].(map[string]any)
		if delta == nil {
			continue
		}
		calls, _ := delta["tool_calls"].([]any)
		for _, raw := range calls {
			if call, ok := raw.(map[string]any); ok {
				out = append(out, call)
			}
		}
	}
	return out
}

func TestPerchSSEStreamEmitsToolCallsAndToolFinish(t *testing.T) {
	events := []map[string]any{
		{"type": "tool_call_delta", "toolCalls": []any{map[string]any{"id": "t_1", "name": "search", "rawArgumentsText": `{"q":"`}}},
		{"type": "tool_call_delta", "toolCalls": []any{map[string]any{"id": "t_1", "rawArgumentsText": `perch"}`}}},
		{"type": "tool_use_end", "toolCalls": []any{map[string]any{"id": "t_1", "name": "search", "arguments": map[string]any{"q": "perch"}}}},
		{"type": "done", "ok": true, "usage": map[string]any{"inputTokens": 4, "outputTokens": 2}},
	}
	chunks := parseChatChunks(t, perchReadSSE(t, perchSSE(events...), false))

	id := ""
	name := ""
	args := ""
	for _, call := range perchToolDeltas(chunks) {
		if value, ok := call["id"].(string); ok {
			id = value
		}
		if fn, ok := call["function"].(map[string]any); ok {
			if value, ok := fn["name"].(string); ok {
				name = value
			}
			if value, ok := fn["arguments"].(string); ok {
				args += value
			}
		}
	}
	if id != "t_1" || name != "search" || args != `{"q":"perch"}` {
		t.Fatalf("tool call = id %q name %q args %q", id, name, args)
	}
	last := chunks[len(chunks)-1]
	choices := last["choices"].([]any)
	finish := choices[0].(map[string]any)["finish_reason"]
	if finish != "tool_calls" {
		t.Fatalf("finish_reason = %#v", finish)
	}
}

func TestPerchSSEStreamEmitsToolNameArrivingAtSeal(t *testing.T) {
	events := []map[string]any{
		{"type": "tool_call_delta", "toolCalls": []any{map[string]any{"id": "t_1", "rawArgumentsText": `{"q":"x"}`}}},
		{"type": "tool_use_end", "toolCalls": []any{map[string]any{"id": "t_1", "name": "search", "arguments": map[string]any{"q": "x"}}}},
		{"type": "done", "ok": true},
	}
	chunks := parseChatChunks(t, perchReadSSE(t, perchSSE(events...), false))

	names := []string{}
	args := ""
	for _, call := range perchToolDeltas(chunks) {
		if fn, ok := call["function"].(map[string]any); ok {
			if value, ok := fn["name"].(string); ok && value != "" {
				names = append(names, value)
			}
			if value, ok := fn["arguments"].(string); ok {
				args += value
			}
		}
	}
	if len(names) == 0 || names[0] != "search" {
		t.Fatalf("tool name never streamed: %#v", perchToolDeltas(chunks))
	}
	if args != `{"q":"x"}` {
		t.Fatalf("tool args = %q", args)
	}
}

func TestPerchMessagesDropsImageParts(t *testing.T) {
	messages := perchMessages(map[string]any{
		"messages": []any{
			map[string]any{"role": "user", "content": []any{
				map[string]any{"type": "text", "text": "describe this"},
				map[string]any{"type": "image_url", "image_url": map[string]any{"url": "data:image/png;base64,AAA"}},
			}},
		},
	})
	if len(messages) != 1 {
		t.Fatalf("messages = %#v", messages)
	}
	user := messages[0].(map[string]any)
	if user["role"] != "user" || user["content"] != "describe this" {
		t.Fatalf("user message = %#v", user)
	}
}

func TestPerchEffortFromBodyMapping(t *testing.T) {
	cases := []struct {
		input   string
		level   string
		enabled bool
	}{
		{"", "high", true},
		{"off", "off", false},
		{"none", "off", false},
		{"low", "low", true},
		{"medium", "medium", true},
		{"high", "high", true},
		{"xhigh", "high", true},
		{"max", "high", true},
	}
	for _, tc := range cases {
		body := map[string]any{}
		if tc.input != "" {
			body["reasoning_effort"] = tc.input
		}
		level, enabled := perchEffortFromBody(body)
		if level != tc.level || enabled != tc.enabled {
			t.Fatalf("reasoning_effort %q = (%q, %v), want (%q, %v)", tc.input, level, enabled, tc.level, tc.enabled)
		}
	}
}

func TestPerchSSEToChatCompletionReportsUpstreamFailure(t *testing.T) {
	cases := []struct {
		name    string
		events  []map[string]any
		message string
		quota   bool
		wantErr bool
	}{
		{
			name: "quota error aborts completion",
			events: []map[string]any{
				{"type": "answer_delta", "text": "partial"},
				{"type": "done", "ok": false, "error": "Monthly allowance reached"},
			},
			message: "Monthly allowance reached",
			quota:   true,
			wantErr: true,
		},
		{
			name: "plain error aborts completion",
			events: []map[string]any{
				{"type": "done", "ok": false, "error": "Upstream model overloaded"},
			},
			message: "Upstream model overloaded",
			quota:   false,
			wantErr: true,
		},
		{
			name: "explicit failure without message",
			events: []map[string]any{
				{"type": "done", "ok": false},
			},
			message: "Perch request failed",
			quota:   false,
			wantErr: true,
		},
		{
			name: "missing ok field is treated as success",
			events: []map[string]any{
				{"type": "answer_delta", "text": "hi"},
				{"type": "done", "usage": map[string]any{"inputTokens": 4, "outputTokens": 1}},
			},
			wantErr: false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			completion, err := perchSSEToChatCompletion(strings.NewReader(perchSSE(tc.events...)), "glm-5", false)
			if !tc.wantErr {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				message := completion["choices"].([]any)[0].(map[string]any)["message"].(map[string]any)
				if message["content"] != "hi" {
					t.Fatalf("content = %#v", message["content"])
				}
				return
			}
			var upstreamErr *perchUpstreamError
			if !errors.As(err, &upstreamErr) {
				t.Fatalf("err = %v, want *perchUpstreamError", err)
			}
			if upstreamErr.Message != tc.message || upstreamErr.Quota != tc.quota {
				t.Fatalf("upstream error = %#v, want message %q quota %v", upstreamErr, tc.message, tc.quota)
			}
		})
	}
}

func TestPerchErrorStatusAndTypeMapping(t *testing.T) {
	quotaErr := &perchUpstreamError{Message: "Monthly allowance reached", Quota: true}
	if perchErrorStatus(quotaErr) != http.StatusTooManyRequests || perchErrorType(quotaErr) != "rate_limit_error" {
		t.Fatalf("quota error status/type = %d/%s", perchErrorStatus(quotaErr), perchErrorType(quotaErr))
	}
	plainErr := &perchUpstreamError{Message: "Upstream model overloaded", Quota: false}
	if perchErrorStatus(plainErr) != http.StatusBadGateway || perchErrorType(plainErr) != "api_error" {
		t.Fatalf("plain error status/type = %d/%s", perchErrorStatus(plainErr), perchErrorType(plainErr))
	}
}

func TestPerchMakeRequestRejectsUnsupportedModel(t *testing.T) {
	resp, err := (perchProvider{}).MakeRequest(context.Background(), nil, "", appdb.ProviderAccount{}, map[string]any{"model": "gpt-4o", "messages": []any{}}, false)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
	var payload map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	errorBody, ok := payload["error"].(map[string]any)
	if !ok {
		t.Fatalf("error body = %#v", payload)
	}
	message, _ := errorBody["message"].(string)
	if !strings.Contains(message, "gpt-4o") || !strings.Contains(message, "not supported for Perch") {
		t.Fatalf("error message = %q", message)
	}
	if errorBody["code"] != "unsupported_perch_model" {
		t.Fatalf("error code = %#v", errorBody["code"])
	}
}
