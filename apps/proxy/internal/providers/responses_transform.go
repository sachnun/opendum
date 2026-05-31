package providers

import (
	"bufio"
	"encoding/json"
	"io"
	"strings"
	"time"
)

func messagesToResponsesInput(messages []any) []any {
	input := []any{}
	for _, raw := range messages {
		msg, _ := raw.(map[string]any)
		role := stringValue(msg["role"])
		content := normalizeResponsesContent(msg["content"], role)
		switch role {
		case "system", "developer":
			input = append(input, map[string]any{"type": "message", "role": "developer", "content": content})
		case "user":
			input = append(input, map[string]any{"type": "message", "role": "user", "content": content})
		case "assistant":
			if calls, ok := msg["tool_calls"].([]any); ok && len(calls) > 0 {
				if content != nil && contentToText(content) != "" {
					input = append(input, map[string]any{"type": "message", "role": "assistant", "content": content})
				}
				for _, rawCall := range calls {
					call, _ := rawCall.(map[string]any)
					fn, _ := call["function"].(map[string]any)
					name := stringValue(fn["name"])
					if name == "" {
						continue
					}
					id := toResponsesAPIID(stringValue(call["id"]))
					input = append(input, map[string]any{"type": "function_call", "id": id, "call_id": id, "name": name, "arguments": defaultStringValue(fn["arguments"], "{}")})
				}
			} else {
				input = append(input, map[string]any{"type": "message", "role": "assistant", "content": content})
			}
		case "tool":
			input = append(input, map[string]any{"type": "function_call_output", "call_id": toResponsesAPIID(stringValue(msg["tool_call_id"])), "output": contentToText(msg["content"])})
		default:
			input = append(input, map[string]any{"type": "message", "role": defaultEmpty(role, "user"), "content": content})
		}
	}
	return input
}

func normalizeResponsesInput(input []any) []any {
	out := make([]any, 0, len(input))
	for _, raw := range input {
		item, ok := raw.(map[string]any)
		if !ok {
			out = append(out, raw)
			continue
		}
		copyItem := cloneAnyMap(item)
		typ := stringValue(copyItem["type"])
		if typ == "function_call" {
			id := toResponsesAPIID(defaultStringValue(copyItem["id"], stringValue(copyItem["call_id"])))
			copyItem["id"] = id
			copyItem["call_id"] = id
		}
		if typ == "function_call_output" {
			copyItem["call_id"] = toResponsesAPIID(stringValue(copyItem["call_id"]))
		}
		if typ == "message" {
			copyItem["content"] = normalizeResponsesContent(copyItem["content"], defaultStringValue(copyItem["role"], "user"))
		}
		out = append(out, copyItem)
	}
	return out
}

func normalizeResponsesContent(content any, role string) any {
	parts, ok := content.([]any)
	if !ok {
		return content
	}
	targetTextType := "input_text"
	if role == "assistant" {
		targetTextType = "output_text"
	}
	out := make([]any, 0, len(parts))
	for _, raw := range parts {
		part, ok := raw.(map[string]any)
		if !ok {
			out = append(out, raw)
			continue
		}
		copyPart := cloneAnyMap(part)
		if copyPart["type"] == "text" {
			copyPart["type"] = targetTextType
		}
		if copyPart["type"] == "image_url" {
			copyPart["type"] = "input_image"
			if imageURL, ok := copyPart["image_url"].(map[string]any); ok {
				copyPart["image_url"] = stringValue(imageURL["url"])
				if imageURL["detail"] != nil {
					copyPart["detail"] = imageURL["detail"]
				}
			}
		}
		out = append(out, copyPart)
	}
	return out
}

func extractInstructions(messages []any) string {
	parts := []string{}
	for _, raw := range messages {
		msg, _ := raw.(map[string]any)
		role := stringValue(msg["role"])
		if role != "system" && role != "developer" {
			continue
		}
		text := strings.TrimSpace(contentToText(msg["content"]))
		if text != "" {
			parts = append(parts, text)
		}
	}
	return strings.Join(parts, "\n\n")
}

func convertToolsForResponses(raw any) []any {
	tools, _ := raw.([]any)
	out := []any{}
	for _, item := range tools {
		tool, _ := item.(map[string]any)
		fn, _ := tool["function"].(map[string]any)
		name := stringValue(fn["name"])
		if name == "" {
			name = stringValue(tool["name"])
			fn = tool
		}
		if name == "" {
			continue
		}
		params, ok := fn["parameters"].(map[string]any)
		if !ok {
			params = map[string]any{"type": "object", "properties": map[string]any{}}
		}
		converted := map[string]any{"type": "function", "name": name, "description": defaultStringValue(fn["description"], ""), "parameters": params}
		if strict, ok := fn["strict"].(bool); ok {
			converted["strict"] = strict
		}
		out = append(out, converted)
	}
	return out
}

func toResponsesAPIID(id string) string {
	if id == "" {
		return randomID("fc")
	}
	if strings.HasPrefix(id, "fc_") || strings.HasPrefix(id, "fc-") || strings.HasPrefix(id, "apc_") {
		return id
	}
	if strings.HasPrefix(id, "call_") {
		return "fc_" + strings.TrimPrefix(id, "call_")
	}
	return "fc_" + id
}

func toChatCallID(id string) string {
	if id == "" {
		return randomID("call")
	}
	if strings.HasPrefix(id, "call_") {
		return id
	}
	if strings.HasPrefix(id, "fc_") || strings.HasPrefix(id, "fc-") {
		return "call_" + id[3:]
	}
	return "call_" + id
}

func responsesSSEToChatSSEReader(source io.Reader, model string) io.Reader {
	reader, writer := io.Pipe()
	go func() {
		transformResponsesSSEToChat(source, writer, model)
		_ = writer.Close()
	}()
	return reader
}

func transformResponsesSSEToChat(source io.Reader, writer io.Writer, model string) {
	completionID := randomID("chatcmpl")
	scanner := bufio.NewScanner(source)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	sentRole := false
	toolIndex := 0
	writeChunk := func(delta map[string]any, finish any, usage map[string]any) {
		chunk := map[string]any{"id": completionID, "object": "chat.completion.chunk", "created": time.Now().Unix(), "model": model, "choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": finish}}}
		if usage != nil {
			chunk["usage"] = usage
		}
		encoded, _ := json.Marshal(chunk)
		_, _ = writer.Write([]byte("data: " + string(encoded) + "\n\n"))
	}
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "" || data == "[DONE]" {
			continue
		}
		var event map[string]any
		if err := json.Unmarshal([]byte(data), &event); err != nil {
			continue
		}
		typ := stringValue(event["type"])
		switch typ {
		case "response.output_text.delta":
			if !sentRole {
				writeChunk(map[string]any{"role": "assistant", "content": ""}, nil, nil)
				sentRole = true
			}
			if delta := stringValue(event["delta"]); delta != "" {
				writeChunk(map[string]any{"content": delta}, nil, nil)
			}
		case "response.reasoning.delta", "response.reasoning_text.delta", "response.reasoning_summary_text.delta":
			if !sentRole {
				writeChunk(map[string]any{"role": "assistant", "content": ""}, nil, nil)
				sentRole = true
			}
			if delta := stringValue(event["delta"]); delta != "" {
				writeChunk(map[string]any{"reasoning_content": delta}, nil, nil)
			}
		case "response.output_item.added":
			item, _ := event["item"].(map[string]any)
			if item["type"] == "function_call" {
				if !sentRole {
					writeChunk(map[string]any{"role": "assistant"}, nil, nil)
					sentRole = true
				}
				id := toChatCallID(defaultStringValue(item["call_id"], stringValue(item["id"])))
				writeChunk(map[string]any{"tool_calls": []any{map[string]any{"index": toolIndex, "id": id, "type": "function", "function": map[string]any{"name": stringValue(item["name"]), "arguments": ""}}}}, nil, nil)
			}
		case "response.function_call_arguments.delta", "response.custom_tool_call_input.delta":
			if delta := stringValue(event["delta"]); delta != "" {
				writeChunk(map[string]any{"tool_calls": []any{map[string]any{"index": toolIndex, "function": map[string]any{"arguments": delta}}}}, nil, nil)
			}
		case "response.function_call_arguments.done", "response.output_item.done":
			item, _ := event["item"].(map[string]any)
			if typ == "response.function_call_arguments.done" || item["type"] == "function_call" {
				toolIndex++
			}
		case "response.completed", "response.done":
			response, _ := event["response"].(map[string]any)
			if response == nil {
				response = event
			}
			usage := responseUsageToChatUsage(response["usage"])
			finish := "stop"
			if response["status"] == "incomplete" {
				finish = "length"
			}
			if toolIndex > 0 {
				finish = "tool_calls"
			}
			writeChunk(map[string]any{}, finish, usage)
		}
	}
	_, _ = writer.Write([]byte("data: [DONE]\n\n"))
}

func responseUsageToChatUsage(raw any) map[string]any {
	usage, _ := raw.(map[string]any)
	input := numberFromAny(usage["input_tokens"])
	if input == 0 {
		input = numberFromAny(usage["prompt_tokens"])
	}
	output := numberFromAny(usage["output_tokens"])
	if output == 0 {
		output = numberFromAny(usage["completion_tokens"])
	}
	return map[string]any{"prompt_tokens": input, "completion_tokens": output, "total_tokens": input + output}
}

func responsesJSONToChatCompletion(data map[string]any, model string) map[string]any {
	content := ""
	reasoning := ""
	toolCalls := []any{}
	output, _ := data["output"].([]any)
	for _, raw := range output {
		item, _ := raw.(map[string]any)
		switch item["type"] {
		case "message":
			parts, _ := item["content"].([]any)
			for _, rawPart := range parts {
				part, _ := rawPart.(map[string]any)
				if part["type"] == "output_text" {
					content += stringValue(part["text"])
				}
			}
		case "reasoning":
			reasoning += extractReasoningFromItem(item)
		case "function_call":
			toolCalls = append(toolCalls, map[string]any{"id": toChatCallID(defaultStringValue(item["call_id"], stringValue(item["id"]))), "type": "function", "function": map[string]any{"name": stringValue(item["name"]), "arguments": defaultStringValue(item["arguments"], "{}")}})
		}
	}
	message := map[string]any{"role": "assistant", "content": nil}
	if content != "" {
		message["content"] = content
	}
	if reasoning != "" {
		message["reasoning_content"] = reasoning
	}
	if len(toolCalls) > 0 {
		message["tool_calls"] = toolCalls
	}
	finish := "stop"
	if data["status"] == "incomplete" {
		finish = "length"
	}
	if len(toolCalls) > 0 {
		finish = "tool_calls"
	}
	return map[string]any{"id": randomID("chatcmpl"), "object": "chat.completion", "created": time.Now().Unix(), "model": model, "choices": []any{map[string]any{"index": 0, "message": message, "finish_reason": finish}}, "usage": responseUsageToChatUsage(data["usage"])}
}

func extractReasoningFromItem(item map[string]any) string {
	chunks := []string{}
	if text := stringValue(item["text"]); text != "" {
		chunks = append(chunks, text)
	}
	if summary, ok := item["summary"].([]any); ok {
		for _, raw := range summary {
			if text, ok := raw.(string); ok && text != "" {
				chunks = append(chunks, text)
				continue
			}
			part, _ := raw.(map[string]any)
			if text := stringValue(part["text"]); text != "" {
				chunks = append(chunks, text)
			}
		}
	}
	return strings.Join(chunks, "\n")
}

func numberFromAny(value any) int {
	switch v := value.(type) {
	case float64:
		return int(v)
	case int:
		return v
	case int64:
		return int(v)
	default:
		return 0
	}
}

func chatCompletionToResponsesJSON(data map[string]any, model string) map[string]any {
	choices, _ := data["choices"].([]any)
	message := map[string]any{}
	finishReason := "stop"
	if len(choices) > 0 {
		choice, _ := choices[0].(map[string]any)
		if choice != nil {
			if msg, _ := choice["message"].(map[string]any); msg != nil {
				message = msg
			}
			if fr := stringValue(choice["finish_reason"]); fr != "" {
				finishReason = fr
			}
		}
	}
	output := []any{}
	content := stringValue(message["content"])
	reasoning := stringValue(message["reasoning_content"])
	if reasoning != "" {
		output = append(output, map[string]any{"type": "reasoning", "text": reasoning})
	}
	if content != "" {
		output = append(output, map[string]any{"type": "message", "role": "assistant", "content": []any{map[string]any{"type": "output_text", "text": content}}})
	}
	if tcs, _ := message["tool_calls"].([]any); len(tcs) > 0 {
		for _, raw := range tcs {
			tc, _ := raw.(map[string]any)
			if tc == nil {
				continue
			}
			fn, _ := tc["function"].(map[string]any)
			name := stringValue(fn["name"])
			if name == "" {
				continue
			}
			id := toResponsesAPIID(stringValue(tc["id"]))
			output = append(output, map[string]any{"type": "function_call", "id": id, "call_id": id, "name": name, "arguments": defaultStringValue(fn["arguments"], "{}")})
		}
	}
	usage, _ := data["usage"].(map[string]any)
	status := "completed"
	if finishReason == "length" {
		status = "incomplete"
	}
	return map[string]any{
		"id":      randomID("resp"),
		"object":  "response",
		"model":   model,
		"output":  output,
		"status":  status,
		"usage":   map[string]any{"input_tokens": numberFromAny(usage["prompt_tokens"]), "output_tokens": numberFromAny(usage["completion_tokens"]), "total_tokens": numberFromAny(usage["prompt_tokens"]) + numberFromAny(usage["completion_tokens"])},
	}
}

type chatToolCallState struct {
	id   string
	name string
	args string
}

func chatSSEToResponsesSSEReader(source io.Reader, model string) io.Reader {
	reader, writer := io.Pipe()
	go func() {
		transformChatSSEToResponses(source, writer, model)
		_ = writer.Close()
	}()
	return reader
}

func transformChatSSEToResponses(source io.Reader, writer io.Writer, model string) {
	responseID := randomID("resp")
	outputItemID := randomID("item")
	textContent := ""
	reasoningContent := ""
	toolCallsAt := map[int]chatToolCallState{}
	toolCallIDs := []int{}
	writtenToolCall := map[int]bool{}
	var promptTokens, completionTokens int

	writeEvent := func(event map[string]any) {
		encoded, _ := json.Marshal(event)
		_, _ = writer.Write([]byte("data: " + string(encoded) + "\n\n"))
	}

	scanner := bufio.NewScanner(source)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "" || data == "[DONE]" {
			continue
		}
		var chunk map[string]any
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			continue
		}
		choices, _ := chunk["choices"].([]any)
		if len(choices) == 0 {
			if usage, ok := chunk["usage"].(map[string]any); ok {
				promptTokens = numberFromAny(usage["prompt_tokens"])
				completionTokens = numberFromAny(usage["completion_tokens"])
			}
			continue
		}
		choice, _ := choices[0].(map[string]any)
		if choice == nil {
			continue
		}
		delta, _ := choice["delta"].(map[string]any)
		finishReason, _ := choice["finish_reason"].(string)

		if delta != nil {
			if content := stringValue(delta["content"]); content != "" {
				textContent += content
				writeEvent(map[string]any{"type": "response.output_text.delta", "delta": content, "item_id": outputItemID, "output_index": 0, "content_index": 0})
			}
			if reasoning := stringValue(delta["reasoning_content"]); reasoning != "" {
				reasoningContent += reasoning
				writeEvent(map[string]any{"type": "response.reasoning_text.delta", "delta": reasoning, "item_id": outputItemID, "output_index": 0, "content_index": 0})
			}
			if tcs, _ := delta["tool_calls"].([]any); len(tcs) > 0 {
				for _, raw := range tcs {
					tc, _ := raw.(map[string]any)
					if tc == nil {
						continue
					}
					idx := numberFromAny(tc["index"])
					fn, _ := tc["function"].(map[string]any)
					if fn == nil {
						fn = map[string]any{}
					}
					if _, exists := toolCallsAt[idx]; !exists {
						id := toResponsesAPIID(stringValue(tc["id"]))
						name := stringValue(fn["name"])
						toolCallsAt[idx] = chatToolCallState{id: id, name: name, args: ""}
						toolCallIDs = append(toolCallIDs, idx)
					}
					entry := toolCallsAt[idx]
					if args := stringValue(fn["arguments"]); args != "" {
						entry.args += args
						toolCallsAt[idx] = entry
					}
					if !writtenToolCall[idx] {
						writeEvent(map[string]any{"type": "response.output_item.added", "item": map[string]any{"type": "function_call", "id": entry.id, "call_id": entry.id, "name": entry.name, "arguments": ""}})
						writtenToolCall[idx] = true
					}
					if args := stringValue(fn["arguments"]); args != "" {
						writeEvent(map[string]any{"type": "response.function_call_arguments.delta", "delta": args, "item_id": entry.id, "output_index": idx})
					}
				}
			}
		}

		if usage, ok := choice["usage"].(map[string]any); ok {
			promptTokens = numberFromAny(usage["prompt_tokens"])
			completionTokens = numberFromAny(usage["completion_tokens"])
		}

		if finishReason != "" {
			output := []any{}
			if reasoningContent != "" {
				output = append(output, map[string]any{"type": "reasoning", "text": reasoningContent})
			}
			if textContent != "" {
				output = append(output, map[string]any{"type": "message", "role": "assistant", "content": []any{map[string]any{"type": "output_text", "text": textContent}}})
			}
			for _, idx := range toolCallIDs {
				if entry, ok := toolCallsAt[idx]; ok {
					output = append(output, map[string]any{"type": "function_call", "id": entry.id, "call_id": entry.id, "name": entry.name, "arguments": entry.args})
				}
			}
			status := "completed"
			if finishReason == "length" {
				status = "incomplete"
			}
			writeEvent(map[string]any{"type": "response.completed", "response": map[string]any{
				"id":     responseID,
				"object": "response",
				"model":  model,
				"output": output,
				"status": status,
				"usage":  map[string]any{"input_tokens": promptTokens, "output_tokens": completionTokens, "total_tokens": promptTokens + completionTokens},
			}})
		}
	}
}
