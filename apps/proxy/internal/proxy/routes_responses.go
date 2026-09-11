package proxy

import (
	"net/http"
	"strings"
)

func responsesConfig(s *Service) endpointAdapter {
	return endpointAdapter{
		Endpoint:             "responses",
		Format:               FormatOpenAI,
		RateLimitStatusCode:  http.StatusTooManyRequests,
		NoAccountsStatusCode: http.StatusServiceUnavailable,
		Parse:                parseResponses,
		Build:                buildResponses,
		HandleStream:         s.passthroughStream,
		HandleNonStream:      s.passthroughNonStream,
	}
}

func responsesToolsToChat(tools []any) []any {
	out := make([]any, 0, len(tools))
	for _, raw := range tools {
		tool, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		switch tool["type"] {
		case "namespace":
			name, _ := tool["name"].(string)
			subs, _ := tool["tools"].([]any)
			for _, sub := range subs {
				subMap, ok := sub.(map[string]any)
				if !ok {
					continue
				}
				fn := cloneMap(subMap)
				delete(fn, "type")
				if childName, ok := fn["name"].(string); ok {
					fn["name"] = name + childName
				}
				out = append(out, map[string]any{"type": "function", "function": fn})
			}
		case "function":
			if _, hasFunction := tool["function"]; !hasFunction {
				fn := cloneMap(tool)
				delete(fn, "type")
				out = append(out, map[string]any{"type": "function", "function": fn})
			} else {
				out = append(out, raw)
			}
		}
	}
	return out
}

func responsesContentToChat(content any) any {
	parts, ok := content.([]any)
	if !ok {
		return content
	}
	out := make([]any, 0, len(parts))
	for _, raw := range parts {
		part, ok := raw.(map[string]any)
		if !ok {
			out = append(out, raw)
			continue
		}
		copyPart := cloneMap(part)
		switch copyPart["type"] {
		case "input_text", "output_text":
			copyPart["type"] = "text"
		case "input_image":
			copyPart["type"] = "image_url"
			if url, ok := copyPart["image_url"].(string); ok {
				copyPart["image_url"] = map[string]any{"url": url}
			}
		}
		out = append(out, copyPart)
	}
	return out
}

func parseResponses(body map[string]any) (parsedEndpointRequest, *routeError) {
	model, routeErr := parseRequiredModel(body)
	if routeErr != nil {
		return parsedEndpointRequest{}, routeErr
	}
	input, ok := body["input"].([]any)
	if !ok {
		return parsedEndpointRequest{}, &routeError{Status: http.StatusBadRequest, Message: "input array is required", Type: "invalid_request_error"}
	}
	stream := parseStreamParam(body)
	instructions, _ := body["instructions"].(string)
	messages := convertResponsesInputToMessages(input, instructions)
	params := cloneMapExcept(body, "model", "input", "instructions", "stream")
	if maxOutput, ok := params["max_output_tokens"]; ok {
		params["max_tokens"] = maxOutput
		delete(params, "max_output_tokens")
	}
	reasoning := reasoningRequested(params)
	paramsForError := buildParamsForError(params, stream)
	if instructions != "" {
		paramsForError["instructions"] = instructions
	}
	return parsedEndpointRequest{ModelParam: model, Stream: stream, ReasoningRequested: reasoning, MessagesForError: messages, ParamsForError: paramsForError, RouteData: map[string]any{"messages": messages, "responsesInput": input, "instructions": instructions, "params": params}}, nil
}

func buildResponses(parsed parsedEndpointRequest, model string, stream bool, sessionID string) map[string]any {
	params, _ := parsed.RouteData["params"].(map[string]any)
	body := cloneMap(params)
	body["model"] = model
	body["messages"] = parsed.RouteData["messages"]
	if tools, ok := body["tools"].([]any); ok {
		body["tools"] = responsesToolsToChat(tools)
	}
	body["stream"] = stream
	body["_includeReasoning"] = parsed.ReasoningRequested
	body["_responsesInput"] = parsed.RouteData["responsesInput"]
	if instructions, _ := parsed.RouteData["instructions"].(string); instructions != "" {
		body["instructions"] = instructions
	}
	addSessionID(body, sessionID)
	return body
}

func convertResponsesInputToMessages(input []any, instructions string) []any {
	messages := []any{}
	if instructions != "" {
		messages = append(messages, map[string]any{"role": "system", "content": instructions})
	}
	pendingToolCalls := []map[string]any{}
	pendingReasoning := ""
	flushToolCalls := func() {
		if len(pendingToolCalls) == 0 {
			return
		}
		calls := make([]any, 0, len(pendingToolCalls))
		for _, call := range pendingToolCalls {
			calls = append(calls, call)
		}
		message := map[string]any{"role": "assistant", "content": "", "tool_calls": calls}
		if pendingReasoning != "" {
			message["reasoning_content"] = pendingReasoning
			pendingReasoning = ""
		}
		messages = append(messages, message)
		pendingToolCalls = []map[string]any{}
	}
	for _, raw := range input {
		item, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		switch responsesInputItemType(item) {
		case "message":
			flushToolCalls()
			role, _ := item["role"].(string)
			if role == "developer" {
				role = "system"
			}
			if role == "" {
				role = "user"
			}
			message := map[string]any{"role": role, "content": responsesContentToChat(item["content"])}
			if role == "assistant" && pendingReasoning != "" {
				message["reasoning_content"] = pendingReasoning
				pendingReasoning = ""
			}
			messages = append(messages, message)
		case "reasoning":
			if text := responsesReasoningText(item); text != "" {
				if pendingReasoning != "" {
					pendingReasoning += "\n\n" + text
				} else {
					pendingReasoning = text
				}
			}
		case "function_call":
			id := stringValue(item["call_id"])
			if id == "" {
				id = stringValue(item["id"])
			}
			if id == "" {
				id = "call_generated"
			}
			id = normalizeCallID(id)
			pendingToolCalls = append(pendingToolCalls, map[string]any{"id": id, "type": "function", "function": map[string]any{"name": stringValue(item["name"]), "arguments": defaultStringValue(item["arguments"], "{}")}})
		case "function_call_output":
			flushToolCalls()
			messages = append(messages, map[string]any{"role": "tool", "content": responsesToolOutputText(item["output"]), "tool_call_id": normalizeCallID(stringValue(item["call_id"]))})
		}
	}
	flushToolCalls()
	return messages
}

// responsesInputItemType infers the item type when a client omits it. The OpenAI
// Responses API accepts shorthand message items without a `type` field, and pi
// sends messages as `{role, content}` only.
func responsesInputItemType(item map[string]any) string {
	if typ := stringValue(item["type"]); typ != "" {
		return typ
	}
	if _, ok := item["summary"]; ok {
		return "reasoning"
	}
	if _, ok := item["encrypted_content"]; ok {
		return "reasoning"
	}
	if item["call_id"] != nil && item["name"] != nil {
		return "function_call"
	}
	if item["call_id"] != nil && item["output"] != nil {
		return "function_call_output"
	}
	if item["role"] != nil {
		return "message"
	}
	return ""
}

func responsesReasoningText(item map[string]any) string {
	parts := []string{}
	if summary, ok := item["summary"].([]any); ok {
		for _, raw := range summary {
			if text := responsesReasoningPartText(raw); text != "" {
				parts = append(parts, text)
			}
		}
	}
	if content, ok := item["content"].([]any); ok {
		for _, raw := range content {
			if text := responsesReasoningPartText(raw); text != "" {
				parts = append(parts, text)
			}
		}
	}
	if len(parts) == 0 {
		if text := stringValue(item["text"]); text != "" {
			return text
		}
	}
	return strings.Join(parts, "\n\n")
}

func responsesReasoningPartText(raw any) string {
	if text, ok := raw.(string); ok {
		return text
	}
	if part, ok := raw.(map[string]any); ok {
		return stringValue(part["text"])
	}
	return ""
}

func responsesToolOutputText(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	if parts, ok := value.([]any); ok {
		chunks := []string{}
		for _, raw := range parts {
			if part, ok := raw.(map[string]any); ok {
				if text := stringValue(part["text"]); text != "" {
					chunks = append(chunks, text)
				}
			}
		}
		return strings.Join(chunks, "\n")
	}
	return ""
}

func normalizeCallID(id string) string {
	if len(id) > 3 && (id[:3] == "fc_" || id[:3] == "fc-") {
		return "call_" + id[3:]
	}
	return id
}

func stringValue(value any) string {
	str, _ := value.(string)
	return str
}

func defaultStringValue(value any, fallback string) string {
	if str, ok := value.(string); ok && str != "" {
		return str
	}
	return fallback
}
