package providers

import (
	"bufio"
	"encoding/json"
	"io"
	"strings"
	"time"
)

// commandCodeSSEToChatSSEReader translates the Command Code CLI `/alpha/generate`
// SSE stream (AI-SDK v3 part shape) into an OpenAI chat.completion.chunk SSE
// stream. The upstream emits one JSON object per line (optionally `data:`-prefixed).
func commandCodeSSEToChatSSEReader(source io.Reader, model string, includeReasoning bool) io.Reader {
	reader, writer := io.Pipe()
	go func() {
		transformCommandCodeSSEToChat(source, writer, model, includeReasoning)
		_ = writer.Close()
	}()
	return reader
}

func transformCommandCodeSSEToChat(source io.Reader, writer io.Writer, model string, includeReasoning bool) {
	completionID := randomID("chatcmpl")
	sentRole := false
	nextToolIndex := 0
	tools := map[string]*ccToolState{}

	writeChunk := func(delta map[string]any, finish any, usage map[string]any) {
		chunk := map[string]any{
			"id":      completionID,
			"object":  "chat.completion.chunk",
			"created": time.Now().Unix(),
			"model":   model,
			"choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": finish}},
		}
		if usage != nil {
			chunk["usage"] = usage
		}
		encoded, _ := json.Marshal(chunk)
		_, _ = writer.Write([]byte("data: " + string(encoded) + "\n\n"))
	}

	ensureRole := func() {
		if !sentRole {
			writeChunk(map[string]any{"role": "assistant", "content": ""}, nil, nil)
			sentRole = true
		}
	}

	emitToolCall := func(state *ccToolState, id string, arguments string, withName bool) {
		delta := map[string]any{"tool_calls": []any{map[string]any{
			"index": state.index,
			"id":    id,
			"type":  "function",
		}}}
		fn := map[string]any{}
		if withName {
			fn["name"] = state.name
		}
		if arguments != "" {
			fn["arguments"] = arguments
		}
		delta["tool_calls"].([]any)[0].(map[string]any)["function"] = fn
		writeChunk(delta, nil, nil)
	}

	scanner := bufio.NewScanner(source)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || line == "[DONE]" || strings.HasPrefix(line, ":") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "" || payload == "[DONE]" {
			continue
		}
		var event map[string]any
		if err := json.Unmarshal([]byte(payload), &event); err != nil {
			continue
		}
		typ := stringValue(event["type"])

		switch typ {
		case "text-delta":
			ensureRole()
			if delta := commandCodeDeltaText(event); delta != "" {
				writeChunk(map[string]any{"content": delta}, nil, nil)
			}
		case "reasoning-delta":
			if includeReasoning {
				ensureRole()
				if delta := commandCodeDeltaText(event); delta != "" {
					writeChunk(map[string]any{"reasoning_content": delta}, nil, nil)
				}
			}
		case "tool-input-start":
			ensureRole()
			id := stringValue(event["id"])
			name := stringValue(event["toolName"])
			state := &ccToolState{index: nextToolIndex, name: name, opened: true}
			tools[id] = state
			nextToolIndex++
			emitToolCall(state, id, "", true)
		case "tool-input-delta":
			id := stringValue(event["id"])
			state, ok := tools[id]
			if !ok {
				state = &ccToolState{index: nextToolIndex, opened: true}
				tools[id] = state
				nextToolIndex++
			}
			if delta := commandCodeDeltaText(event); delta != "" {
				emitToolCall(state, id, delta, false)
			}
		case "tool-call":
			id := defaultStringValue(event["toolCallId"], stringValue(event["id"]))
			name := stringValue(event["toolName"])
			args := commandCodeToolInput(event)
			if state, ok := tools[id]; ok && state.opened {
				// Arguments were streamed via tool-input-delta; nothing to append.
				state.name = name
				continue
			}
			state := &ccToolState{index: nextToolIndex, name: name, opened: true}
			tools[id] = state
			nextToolIndex++
			emitToolCall(state, id, args, true)
		case "finish", "finish-step":
			if typ == "finish-step" {
				continue
			}
			finish := mapCCFinishReason(commandCodeFinishReason(event))
			usage := ccUsageToChatUsage(event["usage"])
			if usage == nil {
				usage = map[string]any{}
			}
			writeChunk(map[string]any{}, finish, usage)
		case "error":
			ensureRole()
			if msg := commandCodeErrorMessage(event); msg != "" {
				writeChunk(map[string]any{"content": msg}, nil, nil)
			}
			writeChunk(map[string]any{}, "stop", map[string]any{"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0})
		}
	}
	_, _ = writer.Write([]byte("data: [DONE]\n\n"))
}

// commandCodeSSEToChatCompletion buffers a full CLI SSE stream and synthesizes
// a single OpenAI chat.completion object for non-streaming requests.
func commandCodeSSEToChatCompletion(source io.Reader, model string, includeReasoning bool) (map[string]any, error) {
	var content, reasoning strings.Builder
	toolCalls := []any{}
	finishReason := "stop"
	var usage map[string]any

	nextToolIndex := 0
	tools := map[string]*ccToolState{}
	pendingArgs := map[string]*strings.Builder{}

	scanner := bufio.NewScanner(source)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || line == "[DONE]" || strings.HasPrefix(line, ":") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "" || payload == "[DONE]" {
			continue
		}
		var event map[string]any
		if err := json.Unmarshal([]byte(payload), &event); err != nil {
			continue
		}
		typ := stringValue(event["type"])

		switch typ {
		case "text-delta":
			if delta := commandCodeDeltaText(event); delta != "" {
				content.WriteString(delta)
			}
		case "reasoning-delta":
			if includeReasoning {
				if delta := commandCodeDeltaText(event); delta != "" {
					reasoning.WriteString(delta)
				}
			}
		case "tool-input-start":
			id := stringValue(event["id"])
			tools[id] = &ccToolState{index: nextToolIndex, name: stringValue(event["toolName"])}
			pendingArgs[id] = &strings.Builder{}
			nextToolIndex++
		case "tool-input-delta":
			id := stringValue(event["id"])
			if b, ok := pendingArgs[id]; ok {
				b.WriteString(commandCodeDeltaText(event))
			}
		case "tool-call":
			id := defaultStringValue(event["toolCallId"], stringValue(event["id"]))
			name := stringValue(event["toolName"])
			args := commandCodeToolInput(event)
			if b, ok := pendingArgs[id]; ok {
				args = b.String()
			}
			if _, exists := tools[id]; !exists {
				tools[id] = &ccToolState{index: nextToolIndex}
				nextToolIndex++
			}
			toolCalls = append(toolCalls, map[string]any{
				"id":       toChatCallID(id),
				"type":     "function",
				"function": map[string]any{"name": name, "arguments": defaultStringValue(args, "{}")},
			})
		case "error":
			if msg := commandCodeErrorMessage(event); msg != "" {
				content.WriteString(msg)
			}
		case "finish":
			finishReason = mapCCFinishReason(commandCodeFinishReason(event))
			usage = ccUsageToChatUsage(event["usage"])
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}

	message := map[string]any{"role": "assistant", "content": nil}
	if text := content.String(); text != "" {
		message["content"] = text
	}
	if includeReasoning {
		if text := reasoning.String(); text != "" {
			message["reasoning_content"] = text
		}
	}
	if len(toolCalls) > 0 {
		message["tool_calls"] = toolCalls
		finishReason = "tool_calls"
	}

	if usage == nil {
		usage = map[string]any{"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
	}

	return map[string]any{
		"id":      randomID("chatcmpl"),
		"object":  "chat.completion",
		"created": time.Now().Unix(),
		"model":   model,
		"choices": []any{map[string]any{"index": 0, "message": message, "finish_reason": finishReason}},
		"usage":   usage,
	}, nil
}

type ccToolState struct {
	index  int
	name   string
	opened bool
}

func commandCodeDeltaText(event map[string]any) string {
	if text := stringValue(event["delta"]); text != "" {
		return text
	}
	return stringValue(event["text"])
}

func commandCodeToolInput(event map[string]any) string {
	if input := event["input"]; input != nil {
		if str, ok := input.(string); ok {
			return str
		}
		encoded, _ := json.Marshal(input)
		return string(encoded)
	}
	if args := event["args"]; args != nil {
		if str, ok := args.(string); ok {
			return str
		}
		encoded, _ := json.Marshal(args)
		return string(encoded)
	}
	if arguments := event["arguments"]; arguments != nil {
		if str, ok := arguments.(string); ok {
			return str
		}
		encoded, _ := json.Marshal(arguments)
		return string(encoded)
	}
	return ""
}

func commandCodeFinishReason(event map[string]any) string {
	for _, key := range []string{"finishReason", "finish_reason"} {
		if value := stringValue(event[key]); value != "" {
			return value
		}
	}
	return "stop"
}

func commandCodeErrorMessage(event map[string]any) string {
	for _, key := range []string{"error", "message"} {
		if value := event[key]; value != nil {
			if str, ok := value.(string); ok {
				return str
			}
			encoded, _ := json.Marshal(value)
			return string(encoded)
		}
	}
	return ""
}

func mapCCFinishReason(raw string) string {
	switch raw {
	case "stop", "end_turn":
		return "stop"
	case "tool_calls", "tool-calls":
		return "tool_calls"
	case "length", "max_tokens", "max-tokens", "max_output_tokens":
		return "length"
	case "content_filter", "content-filter":
		return "content_filter"
	default:
		return "stop"
	}
}

func ccUsageToChatUsage(raw any) map[string]any {
	usage, _ := raw.(map[string]any)
	if usage == nil {
		return nil
	}
	input := commandCodeUsageInt(usage, []string{"inputTokens", "prompt_tokens"})
	output := commandCodeUsageInt(usage, []string{"outputTokens", "completion_tokens"})
	if input == 0 && output == 0 {
		return map[string]any{}
	}
	return map[string]any{"prompt_tokens": input, "completion_tokens": output, "total_tokens": input + output}
}

func commandCodeUsageInt(usage map[string]any, keys []string) int {
	for _, key := range keys {
		if value := numberFromAny(usage[key]); value > 0 {
			return value
		}
	}
	return 0
}
