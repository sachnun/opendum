package proxy

import "net/http"

func chatCompletionsConfig(s *Service) endpointAdapter {
	return endpointAdapter{
		Endpoint:             "chat_completions",
		Format:               FormatOpenAI,
		RateLimitStatusCode:  http.StatusTooManyRequests,
		NoAccountsStatusCode: http.StatusServiceUnavailable,
		Parse:                parseChatCompletions,
		Build:                buildChatCompletions,
		HandleStream:         s.passthroughStream,
		HandleNonStream:      s.passthroughNonStream,
	}
}

func parseChatCompletions(body map[string]any) (parsedEndpointRequest, *routeError) {
	model, routeErr := parseRequiredModel(body)
	if routeErr != nil {
		return parsedEndpointRequest{}, routeErr
	}
	messages, ok := body["messages"].([]any)
	if !ok {
		return parsedEndpointRequest{}, &routeError{Status: http.StatusBadRequest, Message: "messages array is required", Type: "invalid_request_error"}
	}
	stream := parseStreamParam(body)
	providerAccountID := parseProviderAccountID(body)
	params := cloneMapExcept(body, "model", "messages", "stream", "provider_account_id")
	reasoning := reasoningRequested(body)
	paramsForError := buildParamsForError(params, stream, providerAccountID)
	return parsedEndpointRequest{ModelParam: model, Stream: stream, ProviderAccountID: providerAccountID, ReasoningRequested: reasoning, MessagesForError: messages, ParamsForError: paramsForError, RouteData: map[string]any{"messages": messages, "params": params}}, nil
}

func buildChatCompletions(parsed parsedEndpointRequest, model string, stream bool, sessionID string) map[string]any {
	params, _ := parsed.RouteData["params"].(map[string]any)
	body := cloneMap(params)
	body["model"] = model
	body["messages"] = parsed.RouteData["messages"]
	body["stream"] = stream
	body["_includeReasoning"] = parsed.ReasoningRequested
	addSessionID(body, sessionID)
	return body
}

func reasoningRequested(body map[string]any) bool {
	if include, ok := body["include_thoughts"].(bool); ok {
		return include
	}
	if effort := stringValue(body["reasoning_effort"]); effort != "" {
		return effort != "none"
	}
	if reasoning, ok := body["reasoning"].(map[string]any); ok {
		includeValue := reasoning["include_thoughts"]
		if includeValue == nil {
			includeValue = reasoning["includeThoughts"]
		}
		if include, ok := includeValue.(bool); ok {
			return include
		}
		if effort := stringValue(reasoning["effort"]); effort != "" {
			return effort != "none"
		}
		return true
	}
	return body["thinking_budget"] != nil
}

func cloneMapExcept(input map[string]any, excluded ...string) map[string]any {
	exclude := map[string]struct{}{}
	for _, key := range excluded {
		exclude[key] = struct{}{}
	}
	out := map[string]any{}
	for key, value := range input {
		if _, skip := exclude[key]; !skip {
			out[key] = value
		}
	}
	return out
}

func cloneMap(input map[string]any) map[string]any {
	out := map[string]any{}
	for key, value := range input {
		out[key] = value
	}
	return out
}
