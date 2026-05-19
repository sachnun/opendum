package proxy

type requestBodyContextKey struct{}

func messagesConfig(s *Service) endpointAdapter {
	return endpointAdapter{
		Endpoint:             "messages",
		Format:               FormatAnthropic,
		RateLimitStatusCode:  529,
		NoAccountsStatusCode: 529,
		Parse:                parseMessages,
		Build:                buildMessages,
		HandleStream:         s.anthropicStream,
		HandleNonStream:      s.anthropicNonStream,
	}
}

func parseMessages(body map[string]any) (parsedEndpointRequest, *routeError) {
	model, routeErr := parseRequiredModel(body)
	if routeErr != nil {
		return parsedEndpointRequest{}, routeErr
	}
	stream := parseStreamParam(body)
	paramsForError := cloneMapExcept(body, "model", "messages", "stream")
	paramsForError["stream"] = stream
	return parsedEndpointRequest{ModelParam: model, Stream: stream, MessagesForError: body["messages"], ParamsForError: paramsForError, RouteData: map[string]any{"body": body}}, nil
}

func buildMessages(parsed parsedEndpointRequest, model string, stream bool, sessionID string) map[string]any {
	body, _ := parsed.RouteData["body"].(map[string]any)
	payload := transformAnthropicToOpenAI(body)
	payload["model"] = model
	payload["stream"] = stream
	addSessionID(payload, sessionID)
	return payload
}
