package api

import (
	"encoding/json"
	"net/http"
)

type ErrorInfo struct {
	Message      string  `json:"message"`
	Type         string  `json:"type"`
	Param        *string `json:"param"`
	Code         *string `json:"code"`
	RetryAfter   *string `json:"retry_after,omitempty"`
	RetryAfterMS *int64  `json:"retry_after_ms,omitempty"`
}

func WriteOpenAIError(w http.ResponseWriter, status int, info ErrorInfo) {
	if info.Type == "" {
		info.Type = "invalid_request_error"
	}
	writeJSON(w, status, map[string]any{"error": info})
}

func WriteAnthropicError(w http.ResponseWriter, status int, info ErrorInfo) {
	if info.Type == "" {
		info.Type = "invalid_request_error"
	}
	writeJSON(w, status, map[string]any{"type": "error", "error": map[string]any{"type": info.Type, "message": info.Message}})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
