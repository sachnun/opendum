package proxy

import (
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strings"
)

func (s *Service) writeRouteError(w http.ResponseWriter, cfg endpointAdapter, status int, message, typ string, param, code *string, retryAfter *string, retryAfterMS *int64) {
	if typ == "" {
		typ = "invalid_request_error"
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if cfg.Format == FormatAnthropic {
		_ = json.NewEncoder(w).Encode(map[string]any{"type": "error", "error": map[string]any{"type": typ, "message": message}})
		return
	}
	_ = json.NewEncoder(w).Encode(openAIError{Error: openAIErrorInfo{Message: message, Type: typ, Param: param, Code: code, RetryAfter: retryAfter, RetryAfterMS: retryAfterMS}})
}

func sanitizedProxyError(status int, body string) (string, string) {
	typ := "api_error"
	if status >= 400 && status < 500 {
		typ = "invalid_request_error"
	}
	message := extractProviderErrorDetail(body)
	if message == "" {
		message = http.StatusText(status)
		if message == "" {
			message = "Provider request failed"
		}
	}
	return message, typ
}

func extractProviderErrorDetail(body string) string {
	trimmed := strings.TrimSpace(body)
	if trimmed == "" {
		return ""
	}
	var value any
	if json.Unmarshal([]byte(trimmed), &value) == nil {
		if msg := findMessage(value, 0); msg != "" {
			return normalizeClientError(msg)
		}
	}
	return normalizeClientError(trimmed)
}

func findMessage(value any, depth int) string {
	if depth > 6 || value == nil {
		return ""
	}
	switch typed := value.(type) {
	case string:
		var nested any
		if json.Unmarshal([]byte(typed), &nested) == nil {
			if msg := findMessage(nested, depth+1); msg != "" {
				return msg
			}
		}
		return typed
	case map[string]any:
		for _, key := range []string{"message", "detail", "error_description", "error"} {
			if msg := findMessage(typed[key], depth+1); msg != "" {
				return msg
			}
		}
		if errValue, ok := typed["errors"].([]any); ok && len(errValue) > 0 {
			return findMessage(errValue[0], depth+1)
		}
	}
	return ""
}

var whitespaceRegexp = regexp.MustCompile(`\s+`)

func normalizeClientError(value string) string {
	normalized := strings.TrimSpace(whitespaceRegexp.ReplaceAllString(value, " "))
	if len(normalized) > 320 {
		return normalized[:320] + "...[truncated]"
	}
	return normalized
}

func shouldRotate(status int) bool {
	return status >= 500 || status == 429 || status == 408 || status == 404 || status == 403 || status == 402 || status == 401
}

func readBodyLimit(reader io.Reader, limit int64) string {
	data, _ := io.ReadAll(io.LimitReader(reader, limit))
	return string(data)
}

func ptrIfNotEmpty(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}
