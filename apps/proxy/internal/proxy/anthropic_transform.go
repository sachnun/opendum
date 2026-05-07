package proxy

import (
	"encoding/json"
	"strings"
	"time"
)

func transformAnthropicToOpenAI(body map[string]any) map[string]any {
	payload := cloneMapExcept(body, "system", "provider_account_id")
	messages := []any{}
	if system := body["system"]; system != nil {
		messages = append(messages, map[string]any{"role": "system", "content": anthropicSystemToText(system)})
	}
	if rawMessages, ok := body["messages"].([]any); ok {
		for _, raw := range rawMessages {
			messages = append(messages, convertAnthropicMessage(raw)...)
		}
	}
	payload["messages"] = messages
	applyAnthropicThinkingParams(payload, body)
	return payload
}

func convertAnthropicMessage(raw any) []any {
	msg, ok := raw.(map[string]any)
	if !ok {
		return nil
	}
	role := stringValue(msg["role"])
	switch content := msg["content"].(type) {
	case string:
		return []any{map[string]any{"role": role, "content": content}}
	case []any:
		converted := convertAnthropicContentBlocks(content)
		messages := append([]any{}, converted.extraMessages...)
		if len(converted.parts) > 0 || len(converted.toolCalls) > 0 {
			message := map[string]any{"role": role, "content": converted.contentValue()}
			if len(converted.toolCalls) > 0 {
				message["tool_calls"] = converted.toolCalls
			}
			messages = append(messages, message)
		}
		return messages
	}
	return nil
}

func applyAnthropicThinkingParams(payload, body map[string]any) {
	if maxTokens, ok := body["max_tokens"]; ok {
		payload["max_tokens"] = maxTokens
	}
	thinking, ok := body["thinking"].(map[string]any)
	if !ok || thinking["type"] != "enabled" {
		return
	}
	if thinking["budget_tokens"] == nil {
		payload["thinking_budget"] = 10000
	} else {
		payload["thinking_budget"] = thinking["budget_tokens"]
	}
	payload["_includeReasoning"] = true
}

type convertedBlocks struct {
	parts         []any
	toolCalls     []any
	extraMessages []any
}

func (c convertedBlocks) contentValue() any {
	if len(c.parts) == 0 {
		return nil
	}
	texts := []string{}
	for _, raw := range c.parts {
		part, ok := raw.(map[string]any)
		if !ok || part["type"] != "text" {
			return c.parts
		}
		texts = append(texts, stringValue(part["text"]))
	}
	return strings.Join(texts, "")
}

func convertAnthropicContentBlocks(blocks []any) convertedBlocks {
	result := convertedBlocks{}
	for _, raw := range blocks {
		block, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		switch stringValue(block["type"]) {
		case "text":
			if text := stringValue(block["text"]); text != "" {
				result.parts = append(result.parts, map[string]any{"type": "text", "text": text})
			}
		case "image":
			if source, ok := block["source"].(map[string]any); ok {
				if url := stringValue(source["url"]); url != "" {
					result.parts = append(result.parts, map[string]any{"type": "image_url", "image_url": map[string]any{"url": url}})
				}
			}
		case "tool_use":
			args := "{}"
			if block["input"] != nil {
				data, _ := json.Marshal(block["input"])
				args = string(data)
			}
			result.toolCalls = append(result.toolCalls, map[string]any{"id": stringValue(block["id"]), "type": "function", "function": map[string]any{"name": stringValue(block["name"]), "arguments": args}})
		case "tool_result":
			result.extraMessages = append(result.extraMessages, map[string]any{"role": "tool", "tool_call_id": stringValue(block["tool_use_id"]), "content": anthropicToolResultToText(block["content"])})
		}
	}
	return result
}

func transformOpenAIToAnthropic(openAI map[string]any, model string, includeThinking bool) map[string]any {
	content := []any{}
	choices, _ := openAI["choices"].([]any)
	stopReason := "end_turn"
	if len(choices) > 0 {
		choice, _ := choices[0].(map[string]any)
		message, _ := choice["message"].(map[string]any)
		content = appendOpenAIMessageContent(content, message, includeThinking)
		content, stopReason = appendOpenAIToolCalls(content, message, stopReason)
		if finish := stringValue(choice["finish_reason"]); finish == "length" {
			stopReason = "max_tokens"
		}
	}
	if len(content) == 0 {
		content = append(content, map[string]any{"type": "text", "text": ""})
	}
	inputTokens, outputTokens := usageFromJSON(openAI)
	return map[string]any{"id": "msg_" + defaultStringValue(openAI["id"], time.Now().Format("20060102150405")), "type": "message", "role": "assistant", "content": content, "model": model, "stop_reason": stopReason, "stop_sequence": nil, "usage": map[string]any{"input_tokens": inputTokens, "output_tokens": outputTokens}}
}

func appendOpenAIMessageContent(content []any, message map[string]any, includeThinking bool) []any {
	if includeThinking {
		if reasoning := stringValue(message["reasoning_content"]); reasoning != "" {
			content = append(content, map[string]any{"type": "thinking", "thinking": reasoning})
		}
	}
	if text := stringValue(message["content"]); text != "" {
		content = append(content, map[string]any{"type": "text", "text": text})
	}
	return content
}

func appendOpenAIToolCalls(content []any, message map[string]any, stopReason string) ([]any, string) {
	calls, ok := message["tool_calls"].([]any)
	if !ok {
		return content, stopReason
	}
	for _, raw := range calls {
		call, _ := raw.(map[string]any)
		fn, _ := call["function"].(map[string]any)
		var input map[string]any
		_ = json.Unmarshal([]byte(defaultStringValue(fn["arguments"], "{}")), &input)
		content = append(content, map[string]any{"type": "tool_use", "id": stringValue(call["id"]), "name": stringValue(fn["name"]), "input": input})
	}
	if len(calls) > 0 {
		stopReason = "tool_use"
	}
	return content, stopReason
}

func anthropicSystemToText(value any) string {
	if str, ok := value.(string); ok {
		return str
	}
	if blocks, ok := value.([]any); ok {
		parts := []string{}
		for _, raw := range blocks {
			if block, ok := raw.(map[string]any); ok && block["type"] == "text" {
				parts = append(parts, stringValue(block["text"]))
			}
		}
		return strings.Join(parts, "\n")
	}
	return ""
}

func anthropicToolResultToText(value any) string {
	if str, ok := value.(string); ok {
		return str
	}
	data, _ := json.Marshal(value)
	return string(data)
}
