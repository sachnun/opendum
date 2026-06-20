package providers

import (
	"encoding/json"
	"io"
	"strings"
	"testing"
)

func ccEvent(payload map[string]any) string {
	data, _ := json.Marshal(payload)
	return "data: " + string(data) + "\n\n"
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

func TestCommandCodeEnvelopeExtractsSystemAndConvertsMessages(t *testing.T) {
	envelope := buildCommandCodeEnvelope(map[string]any{
		"messages": []any{
			map[string]any{"role": "system", "content": "Be terse."},
			map[string]any{"role": "user", "content": "hi"},
			map[string]any{"role": "assistant", "content": "ok", "tool_calls": []any{map[string]any{"id": "call_1", "function": map[string]any{"name": "search", "arguments": `{"q":"x"}`}}}},
			map[string]any{"role": "tool", "tool_call_id": "call_1", "content": "result"},
		},
		"tools":       []any{map[string]any{"type": "function", "function": map[string]any{"name": "search", "description": "Search the web", "parameters": map[string]any{"type": "object", "properties": map[string]any{}}}}},
		"max_tokens":  100,
		"temperature": 0.5,
	}, "moonshotai/Kimi-K2.7-Code")

	params := envelope["params"].(map[string]any)
	if params["model"] != "moonshotai/Kimi-K2.7-Code" {
		t.Fatalf("model = %v", params["model"])
	}
	if params["system"] != "Be terse." {
		t.Fatalf("system = %#v", params["system"])
	}
	if params["max_tokens"] != 100 {
		t.Fatalf("max_tokens = %v", params["max_tokens"])
	}
	if params["temperature"] != 0.5 {
		t.Fatalf("temperature = %v", params["temperature"])
	}
	if params["stream"] != true {
		t.Fatalf("stream should always be true upstream, got %v", params["stream"])
	}

	messages := params["messages"].([]any)
	if len(messages) != 3 {
		t.Fatalf("messages len = %d (system should be extracted), got %#v", len(messages), messages)
	}
	user := messages[0].(map[string]any)
	if user["role"] != "user" || user["content"] != "hi" {
		t.Fatalf("user message = %#v", user)
	}
	assistant := messages[1].(map[string]any)
	parts := assistant["content"].([]any)
	if len(parts) != 2 {
		t.Fatalf("assistant parts len = %d, got %#v", len(parts), parts)
	}
	if parts[0].(map[string]any)["type"] != "text" {
		t.Fatalf("first assistant part not text: %#v", parts[0])
	}
	tc := parts[1].(map[string]any)
	if tc["type"] != "tool-call" || tc["toolName"] != "search" || tc["toolCallId"] != "call_1" {
		t.Fatalf("tool-call part = %#v", tc)
	}
	tool := messages[2].(map[string]any)
	if tool["role"] != "tool" {
		t.Fatalf("tool message role = %v", tool["role"])
	}
	tr := tool["content"].([]any)[0].(map[string]any)
	if tr["type"] != "tool-result" || tr["toolName"] != "search" {
		t.Fatalf("tool-result = %#v", tr)
	}
	if out := tr["output"].(map[string]any); out["value"] != "result" {
		t.Fatalf("tool output = %#v", out)
	}

	tools := params["tools"].([]any)
	fn := tools[0].(map[string]any)
	if fn["type"] != "function" || fn["name"] != "search" || fn["input_schema"] == nil {
		t.Fatalf("tool = %#v", fn)
	}

	cfg := envelope["config"].(map[string]any)
	if cfg["workingDir"] != "/" || cfg["isGitRepo"] != false {
		t.Fatalf("config = %#v", cfg)
	}
	if envelope["permissionMode"] != "standard" {
		t.Fatalf("permissionMode = %v", envelope["permissionMode"])
	}
}

func TestCommandCodeSSEToChatStreamsTextReasoningAndTools(t *testing.T) {
	stream := ccEvent(map[string]any{"type": "start"}) +
		ccEvent(map[string]any{"type": "text-start", "id": "t1"}) +
		ccEvent(map[string]any{"type": "text-delta", "id": "t1", "delta": "Hel"}) +
		ccEvent(map[string]any{"type": "text-delta", "id": "t1", "delta": "lo"}) +
		ccEvent(map[string]any{"type": "reasoning-delta", "id": "r1", "delta": "thinking"}) +
		ccEvent(map[string]any{"type": "tool-input-start", "id": "ti1", "toolName": "search"}) +
		ccEvent(map[string]any{"type": "tool-input-delta", "id": "ti1", "delta": `{"q":"`}) +
		ccEvent(map[string]any{"type": "tool-input-delta", "id": "ti1", "delta": `x"}`}) +
		ccEvent(map[string]any{"type": "tool-call", "toolCallId": "ti1", "toolName": "search", "input": `{"q":"x"}`}) +
		ccEvent(map[string]any{"type": "finish", "finishReason": "stop", "usage": map[string]any{"inputTokens": 10, "outputTokens": 5}})

	reader := commandCodeSSEToChatSSEReader(strings.NewReader(stream), "glm-5.2", true)
	out, _ := io.ReadAll(reader)
	chunks := parseChatChunks(t, string(out))

	// Expect: role, "Hel", "lo", reasoning, tool-open, tool-arg, tool-arg(no-op already streamed -> tool-call skipped), finish
	// Plus trailing [DONE].
	var content, reasoning string
	var finishReason, finishUsage any
	for _, c := range chunks {
		choices := c["choices"].([]any)
		delta := choices[0].(map[string]any)["delta"].(map[string]any)
		if v, ok := delta["content"].(string); ok {
			content += v
		}
		if v, ok := delta["reasoning_content"].(string); ok {
			reasoning += v
		}
		if fr := choices[0].(map[string]any)["finish_reason"]; fr != nil {
			finishReason = fr
			finishUsage = c["usage"]
		}
	}

	if content != "Hello" {
		t.Fatalf("content = %q, want Hello", content)
	}
	if reasoning != "thinking" {
		t.Fatalf("reasoning = %q, want thinking", reasoning)
	}
	if finishReason != "stop" {
		t.Fatalf("finish_reason = %v, want stop", finishReason)
	}
	usage, _ := finishUsage.(map[string]any)
	if usage == nil || usage["prompt_tokens"] != float64(10) || usage["completion_tokens"] != float64(5) {
		t.Fatalf("usage = %#v", finishUsage)
	}
}

func TestCommandCodeSSEToChatOmitsReasoningWhenNotRequested(t *testing.T) {
	stream := ccEvent(map[string]any{"type": "text-delta", "delta": "hi"}) +
		ccEvent(map[string]any{"type": "reasoning-delta", "delta": "secret"}) +
		ccEvent(map[string]any{"type": "finish", "finishReason": "stop"})

	reader := commandCodeSSEToChatSSEReader(strings.NewReader(stream), "glm-5", false)
	out, _ := io.ReadAll(reader)
	if strings.Contains(string(out), "reasoning_content") {
		t.Fatalf("reasoning leaked while not requested: %s", out)
	}
	if !strings.Contains(string(out), `"hi"`) {
		t.Fatalf("text missing: %s", out)
	}
}

func TestCommandCodeSSEToChatCompletionAssemblesNonStream(t *testing.T) {
	stream := ccEvent(map[string]any{"type": "text-delta", "delta": "world"}) +
		ccEvent(map[string]any{"type": "tool-input-start", "id": "tc1", "toolName": "run"}) +
		ccEvent(map[string]any{"type": "tool-input-delta", "id": "tc1", "delta": `{"x":1}`}) +
		ccEvent(map[string]any{"type": "tool-call", "toolCallId": "tc1", "toolName": "run", "input": `{"x":1}`}) +
		ccEvent(map[string]any{"type": "finish", "finishReason": "tool_calls", "usage": map[string]any{"prompt_tokens": 3, "completion_tokens": 4}})

	completion, err := commandCodeSSEToChatCompletion(strings.NewReader(stream), "kimi-k2.5", true)
	if err != nil {
		t.Fatalf("completion error: %v", err)
	}
	if completion["object"] != "chat.completion" {
		t.Fatalf("object = %v", completion["object"])
	}
	choice := completion["choices"].([]any)[0].(map[string]any)
	message := choice["message"].(map[string]any)
	if message["content"] != "world" {
		t.Fatalf("content = %#v", message["content"])
	}
	if choice["finish_reason"] != "tool_calls" {
		t.Fatalf("finish_reason = %v", choice["finish_reason"])
	}
	calls := message["tool_calls"].([]any)
	call := calls[0].(map[string]any)
	fn := call["function"].(map[string]any)
	if fn["name"] != "run" || fn["arguments"] != `{"x":1}` {
		t.Fatalf("tool call = %#v", call)
	}
	usage := completion["usage"].(map[string]any)
	if numberFromAny(usage["prompt_tokens"]) != 3 || numberFromAny(usage["completion_tokens"]) != 4 {
		t.Fatalf("usage = %#v", usage)
	}
}
