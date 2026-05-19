package proxy

import (
	"net/http"
	"strings"
)

func parseRequiredModel(body map[string]any) (string, *routeError) {
	model, _ := body["model"].(string)
	model = strings.TrimSpace(model)
	if model == "" {
		return "", &routeError{Status: http.StatusBadRequest, Message: "model is required", Type: "invalid_request_error"}
	}
	return model, nil
}

func parseStreamParam(body map[string]any) bool {
	if value, ok := body["stream"].(bool); ok {
		return value
	}
	return true
}

func buildParamsForError(params map[string]any, stream bool) map[string]any {
	out := cloneMap(params)
	out["stream"] = stream
	return out
}

func addSessionID(payload map[string]any, sessionID string) {
	if sessionID != "" {
		payload["_sessionId"] = sessionID
	}
}
