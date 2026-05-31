package proxy

import "net/http"

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
	flushToolCalls := func() {
		if len(pendingToolCalls) == 0 {
			return
		}
		calls := make([]any, 0, len(pendingToolCalls))
		for _, call := range pendingToolCalls {
			calls = append(calls, call)
		}
		messages = append(messages, map[string]any{"role": "assistant", "content": "", "tool_calls": calls})
		pendingToolCalls = []map[string]any{}
	}
	for _, raw := range input {
		item, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		typeValue, _ := item["type"].(string)
		switch typeValue {
		case "message":
			flushToolCalls()
			role, _ := item["role"].(string)
			if role == "developer" {
				role = "system"
			}
			if role == "" {
				role = "user"
			}
			messages = append(messages, map[string]any{"role": role, "content": responsesContentToChat(item["content"])})
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
			messages = append(messages, map[string]any{"role": "tool", "content": defaultStringValue(item["output"], ""), "tool_call_id": normalizeCallID(stringValue(item["call_id"]))})
		}
	}
	flushToolCalls()
	return messages
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
