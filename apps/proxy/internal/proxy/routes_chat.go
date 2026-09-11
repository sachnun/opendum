package proxy

import (
	"net/http"
	"strings"
)

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
	params := cloneMapExcept(body, "model", "messages", "stream")
	reasoning := reasoningRequested(body)
	paramsForError := buildParamsForError(params, stream)
	return parsedEndpointRequest{ModelParam: model, Stream: stream, ReasoningRequested: reasoning, MessagesForError: messages, ParamsForError: paramsForError, RouteData: map[string]any{"messages": messages, "params": params}}, nil
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

// reasoningDisabled reports whether the client explicitly turned thinking off.
// pi sends `reasoning: {effort: "none"}` (and some clients send
// `reasoning_effort: "none"` or `include_thoughts: false`) for models whose
// thinking level map marks "off". These must not be treated as "reasoning
// requested", otherwise the upstream keeps thinking and the reply loses its
// answer budget.
func reasoningDisabled(body map[string]any) bool {
	if include, ok := body["include_thoughts"].(bool); ok {
		return !include
	}
	if effort := strings.ToLower(strings.TrimSpace(stringValue(body["reasoning_effort"]))); effort != "" {
		return effort == "none"
	}
	if reasoning, ok := body["reasoning"].(map[string]any); ok {
		includeValue := reasoning["include_thoughts"]
		if includeValue == nil {
			includeValue = reasoning["includeThoughts"]
		}
		if include, ok := includeValue.(bool); ok && !include {
			return true
		}
		if effort := strings.ToLower(strings.TrimSpace(stringValue(reasoning["effort"]))); effort != "" {
			return effort == "none"
		}
	}
	return false
}

func reasoningRequested(body map[string]any) bool {
	if reasoningDisabled(body) {
		return false
	}
	if include, ok := body["include_thoughts"].(bool); ok {
		return include
	}
	if effort := stringValue(body["reasoning_effort"]); effort != "" {
		return true
	}
	if _, ok := body["reasoning"].(map[string]any); ok {
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
