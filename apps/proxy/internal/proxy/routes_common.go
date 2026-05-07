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

func parseProviderAccountID(body map[string]any) *string {
	if value, ok := body["provider_account_id"].(string); ok {
		return &value
	}
	return nil
}

func buildParamsForError(params map[string]any, stream bool, providerAccountID *string) map[string]any {
	out := cloneMap(params)
	out["stream"] = stream
	if providerAccountID != nil && *providerAccountID != "" {
		out["provider_account_id"] = *providerAccountID
	}
	return out
}

func addSessionID(payload map[string]any, sessionID string) {
	if sessionID != "" {
		payload["_sessionId"] = sessionID
	}
}
