package providers

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
)

func buildAnthropicMessagesPayload(ctx context.Context, client *http.Client, body map[string]any, modelName string, stream bool) map[string]any {
	payload := map[string]any{"model": modelName, "stream": stream, "max_tokens": anthropicMaxTokens(body)}
	messages, _ := body["messages"].([]any)
	messages = convertImageURLsToBase64(ctx, client, messages)
	system, converted := anthropicMessagesFromChat(messages)
	if system != "" {
		payload["system"] = system
	}
	payload["messages"] = converted
	if body["temperature"] != nil {
		payload["temperature"] = body["temperature"]
	}
	if body["top_p"] != nil {
		payload["top_p"] = body["top_p"]
	}
	if stop := anthropicStopSequences(body["stop"]); len(stop) > 0 {
		payload["stop_sequences"] = stop
	}
	if tools := anthropicToolsFromChat(body["tools"]); len(tools) > 0 {
		payload["tools"] = tools
		if choice := anthropicToolChoiceFromChat(body["tool_choice"]); choice != nil {
			payload["tool_choice"] = choice
		}
	}
	applyAnthropicThinking(payload, body)
	return payload
}

func anthropicMaxTokens(body map[string]any) int {
	for _, key := range []string{"max_tokens", "max_completion_tokens", "max_output_tokens"} {
		if value := numberFromAny(body[key]); value > 0 {
			return value
		}
	}
	return 4096
}

func anthropicStopSequences(value any) []any {
	switch typed := value.(type) {
	case string:
		if typed != "" {
			return []any{typed}
		}
	case []any:
		return typed
	}
	return nil
}

func anthropicMessagesFromChat(messages []any) (string, []any) {
	system := []string{}
	out := []any{}
	toolResults := []any{}
	flushToolResults := func() {
		if len(toolResults) > 0 {
			out = append(out, map[string]any{"role": "user", "content": toolResults})
			toolResults = []any{}
		}
	}
	for _, raw := range messages {
		msg, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		switch stringValue(msg["role"]) {
		case "system", "developer":
			flushToolResults()
			if text := contentToText(msg["content"]); text != "" {
				system = append(system, text)
			}
		case "user":
			flushToolResults()
			if blocks := anthropicContentBlocks(msg["content"]); len(blocks) > 0 {
				out = append(out, map[string]any{"role": "user", "content": blocks})
			}
		case "assistant":
			flushToolResults()
			if blocks := anthropicAssistantBlocks(msg); len(blocks) > 0 {
				out = append(out, map[string]any{"role": "assistant", "content": blocks})
			}
		case "tool":
			toolResults = append(toolResults, map[string]any{"type": "tool_result", "tool_use_id": stringValue(msg["tool_call_id"]), "content": anthropicToolResultContent(msg["content"])})
		}
	}
	flushToolResults()
	return strings.Join(system, "\n\n"), out
}

func anthropicContentBlocks(content any) []any {
	if text, ok := content.(string); ok {
		return []any{map[string]any{"type": "text", "text": text}}
	}
	parts, ok := content.([]any)
	if !ok {
		if content == nil {
			return nil
		}
		if text := contentToText(content); text != "" {
			return []any{map[string]any{"type": "text", "text": text}}
		}
		return nil
	}
	blocks := []any{}
	for _, raw := range parts {
		part, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		switch stringValue(part["type"]) {
		case "text", "input_text", "output_text":
			if text := stringValue(part["text"]); text != "" {
				blocks = append(blocks, map[string]any{"type": "text", "text": text})
			}
		case "image_url":
			if block := anthropicImageBlock(part["image_url"]); block != nil {
				blocks = append(blocks, block)
			}
		case "image":
			if block := anthropicImageBlock(part["source"]); block != nil {
				blocks = append(blocks, block)
			}
		}
	}
	return blocks
}

func anthropicAssistantBlocks(msg map[string]any) []any {
	blocks := []any{}
	if text := contentToText(msg["content"]); text != "" {
		blocks = append(blocks, map[string]any{"type": "text", "text": text})
	}
	calls, _ := msg["tool_calls"].([]any)
	for _, raw := range calls {
		call, _ := raw.(map[string]any)
		fn, _ := call["function"].(map[string]any)
		name := stringValue(fn["name"])
		if name == "" {
			continue
		}
		var input any = map[string]any{}
		if args := stringValue(fn["arguments"]); args != "" {
			_ = json.Unmarshal([]byte(args), &input)
		}
		blocks = append(blocks, map[string]any{"type": "tool_use", "id": defaultStringValue(stringValue(call["id"]), randomID("toolu")), "name": name, "input": input})
	}
	return blocks
}

func anthropicImageBlock(value any) map[string]any {
	source, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	if stringValue(source["type"]) == "base64" && stringValue(source["data"]) != "" {
		return map[string]any{"type": "image", "source": source}
	}
	url := stringValue(source["url"])
	if url == "" {
		return nil
	}
	if mediaType, data, ok := parseDataURI(url); ok {
		return map[string]any{"type": "image", "source": map[string]any{"type": "base64", "media_type": mediaType, "data": data}}
	}
	return map[string]any{"type": "image", "source": map[string]any{"type": "url", "url": url}}
}

func parseDataURI(value string) (string, string, bool) {
	trimmed, ok := strings.CutPrefix(value, "data:")
	if !ok {
		return "", "", false
	}
	header, data, ok := strings.Cut(trimmed, ",")
	if !ok || data == "" {
		return "", "", false
	}
	mediaType := strings.TrimSuffix(header, ";base64")
	if mediaType == "" {
		mediaType = "image/png"
	}
	return mediaType, data, true
}

func anthropicToolResultContent(content any) any {
	if text, ok := content.(string); ok {
		return text
	}
	if text := contentToText(content); text != "" {
		return text
	}
	return ""
}

func anthropicToolsFromChat(raw any) []any {
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
		converted := map[string]any{"name": name, "input_schema": params}
		if description := stringValue(fn["description"]); description != "" {
			converted["description"] = description
		}
		out = append(out, converted)
	}
	return out
}

func anthropicToolChoiceFromChat(raw any) any {
	switch typed := raw.(type) {
	case string:
		switch typed {
		case "auto":
			return map[string]any{"type": "auto"}
		case "required", "any":
			return map[string]any{"type": "any"}
		case "none":
			return map[string]any{"type": "none"}
		}
	case map[string]any:
		name := stringValue(typed["name"])
		if fn, ok := typed["function"].(map[string]any); ok {
			name = stringValue(fn["name"])
		}
		if name != "" {
			return map[string]any{"type": "tool", "name": name}
		}
		switch stringValue(typed["type"]) {
		case "auto":
			return map[string]any{"type": "auto"}
		case "required", "any":
			return map[string]any{"type": "any"}
		case "none":
			return map[string]any{"type": "none"}
		}
	}
	return nil
}

func applyAnthropicThinking(payload, body map[string]any) {
	budget := numberFromAny(body["thinking_budget"])
	if budget == 0 {
		budget = anthropicEffortBudget(body)
	}
	if budget <= 0 {
		return
	}
	if maxTokens := numberFromAny(payload["max_tokens"]); maxTokens <= budget {
		payload["max_tokens"] = budget + 1024
	}
	payload["thinking"] = map[string]any{"type": "enabled", "budget_tokens": budget}
}

func anthropicEffortBudget(body map[string]any) int {
	if !isTruthful(body["_includeReasoning"]) {
		return 0
	}
	effort := strings.ToLower(stringValue(body["reasoning_effort"]))
	if reasoning, ok := body["reasoning"].(map[string]any); ok && effort == "" {
		effort = strings.ToLower(stringValue(reasoning["effort"]))
	}
	switch effort {
	case "minimal":
		return 1024
	case "low":
		return 2048
	case "medium":
		return 8192
	case "high":
		return 16384
	}
	return 0
}

func anthropicMessagesToChatCompletion(data map[string]any, model string) map[string]any {
	content := ""
	reasoning := ""
	toolCalls := []any{}
	blocks, _ := data["content"].([]any)
	for _, raw := range blocks {
		block, _ := raw.(map[string]any)
		switch stringValue(block["type"]) {
		case "text":
			content += stringValue(block["text"])
		case "thinking":
			reasoning += stringValue(block["thinking"])
		case "tool_use":
			args := "{}"
			if block["input"] != nil {
				if encoded, err := json.Marshal(block["input"]); err == nil {
					args = string(encoded)
				}
			}
			toolCalls = append(toolCalls, map[string]any{"id": defaultStringValue(stringValue(block["id"]), randomID("call")), "type": "function", "function": map[string]any{"name": stringValue(block["name"]), "arguments": args}})
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
	finish := anthropicStopReasonToFinish(stringValue(data["stop_reason"]), len(toolCalls) > 0)
	return map[string]any{
		"id":      defaultStringValue(stringValue(data["id"]), randomID("chatcmpl")),
		"object":  "chat.completion",
		"created": time.Now().Unix(),
		"model":   defaultStringValue(model, stringValue(data["model"])),
		"choices": []any{map[string]any{"index": 0, "message": message, "finish_reason": finish}},
		"usage":   anthropicUsageToChatUsage(data["usage"]),
	}
}

func anthropicStopReasonToFinish(reason string, hasToolCalls bool) string {
	switch reason {
	case "max_tokens":
		return "length"
	case "tool_use":
		return "tool_calls"
	case "refusal":
		return "content_filter"
	}
	if hasToolCalls {
		return "tool_calls"
	}
	return "stop"
}

func anthropicUsageToChatUsage(raw any) map[string]any {
	usage, _ := raw.(map[string]any)
	input := numberFromAny(usage["input_tokens"])
	output := numberFromAny(usage["output_tokens"])
	out := map[string]any{"prompt_tokens": input, "completion_tokens": output, "total_tokens": input + output}
	cached := numberFromAny(usage["cache_read_input_tokens"])
	write := numberFromAny(usage["cache_creation_input_tokens"])
	if cached > 0 || write > 0 {
		out["prompt_tokens_details"] = map[string]any{"cached_tokens": cached, "cache_write_tokens": write}
	}
	return out
}

func anthropicMessagesSSEToChatSSEReader(source io.Reader, model string) io.Reader {
	reader, writer := io.Pipe()
	go func() {
		transformAnthropicMessagesSSEToChat(source, writer, model)
		_ = writer.Close()
	}()
	return reader
}

func transformAnthropicMessagesSSEToChat(source io.Reader, writer io.Writer, model string) {
	completionID := randomID("chatcmpl")
	modelName := model
	scanner := bufio.NewScanner(source)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	sentRole := false
	toolIndex := -1
	toolIndexByBlock := map[int]int{}
	finish := "stop"
	var usage map[string]any

	writeChunk := func(delta map[string]any, finishReason any) {
		chunk := map[string]any{"id": completionID, "object": "chat.completion.chunk", "created": time.Now().Unix(), "model": modelName, "choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": finishReason}}}
		if usage != nil && finishReason != nil {
			chunk["usage"] = usage
		}
		encoded, _ := json.Marshal(chunk)
		_, _ = writer.Write([]byte("data: " + string(encoded) + "\n\n"))
	}
	ensureRole := func() {
		if !sentRole {
			writeChunk(map[string]any{"role": "assistant", "content": ""}, nil)
			sentRole = true
		}
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
		switch stringValue(event["type"]) {
		case "message_start":
			if message, ok := event["message"].(map[string]any); ok {
				if id := stringValue(message["id"]); id != "" {
					completionID = id
				}
				if name := stringValue(message["model"]); name != "" {
					modelName = name
				}
			}
		case "content_block_start":
			block, _ := event["content_block"].(map[string]any)
			if stringValue(block["type"]) != "tool_use" {
				continue
			}
			ensureRole()
			toolIndex++
			toolIndexByBlock[numberFromAny(event["index"])] = toolIndex
			writeChunk(map[string]any{"tool_calls": []any{map[string]any{"index": toolIndex, "id": defaultStringValue(stringValue(block["id"]), randomID("call")), "type": "function", "function": map[string]any{"name": stringValue(block["name"]), "arguments": ""}}}}, nil)
		case "content_block_delta":
			delta, _ := event["delta"].(map[string]any)
			switch stringValue(delta["type"]) {
			case "text_delta":
				if text := stringValue(delta["text"]); text != "" {
					ensureRole()
					writeChunk(map[string]any{"content": text}, nil)
				}
			case "thinking_delta":
				if text := stringValue(delta["thinking"]); text != "" {
					ensureRole()
					writeChunk(map[string]any{"reasoning_content": text}, nil)
				}
			case "input_json_delta":
				partial := stringValue(delta["partial_json"])
				if partial == "" {
					continue
				}
				blockIndex := numberFromAny(event["index"])
				index, ok := toolIndexByBlock[blockIndex]
				if !ok {
					toolIndex++
					index = toolIndex
					toolIndexByBlock[blockIndex] = index
					ensureRole()
					writeChunk(map[string]any{"tool_calls": []any{map[string]any{"index": index, "id": randomID("call"), "type": "function", "function": map[string]any{"name": "", "arguments": ""}}}}, nil)
				}
				writeChunk(map[string]any{"tool_calls": []any{map[string]any{"index": index, "function": map[string]any{"arguments": partial}}}}, nil)
			}
		case "message_delta":
			if delta, ok := event["delta"].(map[string]any); ok {
				finish = anthropicStopReasonToFinish(stringValue(delta["stop_reason"]), toolIndex >= 0)
			}
			if event["usage"] != nil {
				usage = anthropicUsageToChatUsage(event["usage"])
			}
		case "message_stop":
			if !sentRole {
				writeChunk(map[string]any{"role": "assistant", "content": ""}, finish)
				sentRole = true
				break
			}
			writeChunk(map[string]any{}, finish)
		}
	}
	if !sentRole {
		writeChunk(map[string]any{"role": "assistant", "content": ""}, finish)
	}
	_, _ = writer.Write([]byte("data: [DONE]\n\n"))
}
