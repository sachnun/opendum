package proxy

import (
	"encoding/json"
	"strings"
	"time"
)

func transformAnthropicToOpenAI(body map[string]any) map[string]any {
	payload := cloneMapExcept(body, "system", "provider_account_id", "thinking", "output_config")
	if _, ok := payload["max_tokens"]; !ok {
		payload["max_tokens"] = 4096
	}
	if tools, ok := body["tools"].([]any); ok {
		payload["tools"] = convertAnthropicTools(tools)
	}
	if toolChoice, ok := body["tool_choice"]; ok {
		payload["tool_choice"] = convertAnthropicToolChoice(toolChoice)
	}
	messages := []any{}
	if system := body["system"]; system != nil {
		messages = append(messages, map[string]any{"role": "system", "content": anthropicSystemToText(system)})
	}
	toolResultIDs := anthropicToolResultIDs(body["messages"])
	if rawMessages, ok := body["messages"].([]any); ok {
		for _, raw := range rawMessages {
			messages = append(messages, convertAnthropicMessage(raw, toolResultIDs)...)
		}
	}
	payload["messages"] = messages
	applyAnthropicThinkingParams(payload, body)
	return payload
}

func convertAnthropicMessage(raw any, toolResultIDs map[string]struct{}) []any {
	msg, ok := raw.(map[string]any)
	if !ok {
		return nil
	}
	role := stringValue(msg["role"])
	switch content := msg["content"].(type) {
	case string:
		return []any{map[string]any{"role": role, "content": content}}
	case []any:
		converted := convertAnthropicContentBlocks(content, toolResultIDs)
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

func convertAnthropicTools(tools []any) []any {
	converted := make([]any, 0, len(tools))
	for _, raw := range tools {
		tool, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if _, ok := tool["function"]; ok {
			converted = append(converted, tool)
			continue
		}
		name := stringValue(tool["name"])
		if name == "" {
			continue
		}
		parameters := tool["input_schema"]
		if parameters == nil {
			parameters = map[string]any{}
		}
		function := map[string]any{
			"name":        name,
			"description": stringValue(tool["description"]),
			"parameters":  parameters,
		}
		converted = append(converted, map[string]any{"type": "function", "function": function})
	}
	return converted
}

func convertAnthropicToolChoice(toolChoice any) any {
	if choice, ok := toolChoice.(string); ok {
		if choice == "auto" || choice == "none" || choice == "required" {
			return choice
		}
		return toolChoice
	}
	choiceMap, ok := toolChoice.(map[string]any)
	if !ok {
		return toolChoice
	}
	if choiceMap["function"] != nil {
		return choiceMap
	}
	switch stringValue(choiceMap["type"]) {
	case "auto":
		return "auto"
	case "any", "required":
		return "required"
	case "tool", "function":
		name := stringValue(choiceMap["name"])
		if name == "" {
			if fn, ok := choiceMap["function"].(map[string]any); ok {
				name = stringValue(fn["name"])
			}
		}
		return map[string]any{"type": "function", "function": map[string]any{"name": name}}
	case "none":
		return "none"
	}
	return toolChoice
}

func applyAnthropicThinkingParams(payload, body map[string]any) {
	if maxTokens, ok := body["max_tokens"]; ok {
		payload["max_tokens"] = maxTokens
	}
	thinking, ok := body["thinking"].(map[string]any)
	if !ok {
		return
	}
	if thinking["type"] == "adaptive" {
		payload["reasoning_effort"] = anthropicEffort(body)
		payload["_includeReasoning"] = true
		return
	}
	if thinking["type"] != "enabled" {
		return
	}
	if thinking["budget_tokens"] == nil {
		payload["thinking_budget"] = 10000
	} else {
		payload["thinking_budget"] = thinking["budget_tokens"]
	}
	payload["_includeReasoning"] = true
}

func anthropicEffort(body map[string]any) string {
	if outputConfig, ok := body["output_config"].(map[string]any); ok {
		if effort := stringValue(outputConfig["effort"]); effort != "" {
			return effort
		}
	}
	return "high"
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

func convertAnthropicContentBlocks(blocks []any, toolResultIDs map[string]struct{}) convertedBlocks {
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
			id := stringValue(block["id"])
			if id != "" {
				if _, ok := toolResultIDs[id]; !ok {
					continue
				}
			}
			args := "{}"
			if block["input"] != nil {
				data, _ := json.Marshal(block["input"])
				args = string(data)
			}
			result.toolCalls = append(result.toolCalls, map[string]any{"id": id, "type": "function", "function": map[string]any{"name": stringValue(block["name"]), "arguments": args}})
		case "tool_result":
			result.extraMessages = append(result.extraMessages, map[string]any{"role": "tool", "tool_call_id": stringValue(block["tool_use_id"]), "content": anthropicToolResultToText(block["content"])})
		}
	}
	return result
}

func anthropicToolResultIDs(rawMessages any) map[string]struct{} {
	ids := map[string]struct{}{}
	messages, ok := rawMessages.([]any)
	if !ok {
		return ids
	}
	for _, raw := range messages {
		msg, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		blocks, ok := msg["content"].([]any)
		if !ok {
			continue
		}
		for _, rawBlock := range blocks {
			block, ok := rawBlock.(map[string]any)
			if !ok || block["type"] != "tool_result" {
				continue
			}
			if id := stringValue(block["tool_use_id"]); id != "" {
				ids[id] = struct{}{}
			}
		}
	}
	return ids
}

func transformOpenAIToAnthropic(openAI map[string]any, model string) map[string]any {
	content := []any{}
	choices, _ := openAI["choices"].([]any)
	stopReason := "end_turn"
	if len(choices) > 0 {
		choice, _ := choices[0].(map[string]any)
		message, _ := choice["message"].(map[string]any)
		content = appendOpenAIMessageContent(content, message)
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

func appendOpenAIMessageContent(content []any, message map[string]any) []any {
	if reasoning := stringValue(message["reasoning_content"]); reasoning != "" {
		content = append(content, map[string]any{"type": "thinking", "thinking": reasoning})
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
