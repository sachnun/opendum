package proxy

import (
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	accountErrorTextLimit         = 200
	accountErrorRawMessageLimit   = 2000
	accountErrorArrayPreviewLimit = 10
	accountErrorMessageLimit      = 30
)

func (s *Service) writeRouteError(w http.ResponseWriter, cfg endpointAdapter, status int, message, typ string, param, code *string, retryAfter *string, retryAfterMS *int64) {
	if typ == "" {
		typ = "invalid_request_error"
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if cfg.Format == FormatAnthropic {
		errorBody := map[string]any{"type": typ, "message": message}
		if retryAfter != nil {
			errorBody["retry_after"] = *retryAfter
		}
		if retryAfterMS != nil {
			errorBody["retry_after_ms"] = *retryAfterMS
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"type": "error", "error": errorBody})
		return
	}
	_ = json.NewEncoder(w).Encode(openAIError{Error: openAIErrorInfo{Message: message, Type: typ, Param: param, Code: code, RetryAfter: retryAfter, RetryAfterMS: retryAfterMS}})
}

func sanitizedProxyError(status int, body string) (string, string) {
	typ := providerErrorType(status)
	message := extractProviderErrorDetail(body)
	if message == "" {
		message = http.StatusText(status)
		if message == "" {
			message = "Provider request failed"
		}
	}
	return message, typ
}

func providerErrorType(status int) string {
	switch status {
	case http.StatusUnauthorized:
		return "authentication_error"
	case http.StatusForbidden:
		return "authentication_error"
	case http.StatusRequestTimeout:
		return "timeout_error"
	case http.StatusTooManyRequests:
		return "rate_limit_error"
	}
	if status >= 500 {
		return "api_error"
	}
	if status >= 400 {
		return "invalid_request_error"
	}
	return "api_error"
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
	return status >= 500 || status == http.StatusTooManyRequests || status == http.StatusRequestTimeout || status == http.StatusNotFound || status == http.StatusForbidden || status == http.StatusPaymentRequired || status == http.StatusUnauthorized
}

func retryMetadata(d time.Duration) (*string, *int64) {
	if d <= 0 {
		return nil, nil
	}
	ms := int64(d / time.Millisecond)
	if ms < 1 {
		ms = 1
	}
	seconds := int64(d / time.Second)
	if d%time.Second != 0 {
		seconds++
	}
	if seconds < 1 {
		seconds = 1
	}
	value := strconv.FormatInt(seconds, 10) + "s"
	return &value, &ms
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

type accountErrorContext struct {
	Model      string
	Provider   string
	Endpoint   string
	Messages   any
	Parameters map[string]any
}

func buildAccountErrorMessage(errorMessage string, context accountErrorContext) string {
	truncatedError := errorMessage
	if len(truncatedError) > accountErrorRawMessageLimit {
		truncatedError = truncatedError[:accountErrorRawMessageLimit] + "...[truncated, " + strconv.Itoa(len(errorMessage)) + " chars total]"
	}

	serializedParameters := "{}"
	if data, err := json.MarshalIndent(sanitizeParametersForError(context.Parameters), "", "  "); err == nil {
		serializedParameters = string(data)
	} else {
		serializedParameters = `"[unserializable parameters]"`
	}

	lines := []string{"Error: " + truncatedError}
	if context.Provider != "" {
		lines = append(lines, "Provider: "+context.Provider)
	}
	if context.Endpoint != "" {
		lines = append(lines, "Endpoint: "+context.Endpoint)
	}
	lines = append(lines, "Model: "+context.Model, "Parameters: "+serializedParameters)
	if summary := summarizeMessagesForError(context.Messages); summary != "" {
		lines = append(lines, "Messages (object keys only): "+summary)
	}
	return strings.Join(lines, "\n")
}

func sanitizeParametersForError(params map[string]any) map[string]any {
	sanitized := map[string]any{}
	for key, value := range params {
		if key == "messages" {
			sanitized[key] = "[redacted: see \"Messages (object keys only)\"]"
			continue
		}
		sanitized[key] = sanitizeValueForError(value, key)
	}
	return sanitized
}

func sanitizeValueForError(value any, key string) any {
	switch typed := value.(type) {
	case nil:
		return nil
	case string:
		return truncateAccountErrorString(typed)
	case []any:
		if key == "tools" {
			return summarizeToolsForError(typed)
		}
		limit := len(typed)
		truncated := false
		if limit > accountErrorArrayPreviewLimit {
			limit = accountErrorArrayPreviewLimit
			truncated = true
		}
		items := make([]any, 0, limit+1)
		for i := 0; i < limit; i++ {
			items = append(items, sanitizeValueForError(typed[i], key))
		}
		if truncated {
			items = append(items, "...[truncated, "+strconv.Itoa(len(typed))+" items total]")
		}
		return items
	case map[string]any:
		out := map[string]any{}
		for k, v := range typed {
			out[k] = sanitizeValueForError(v, k)
		}
		return out
	default:
		return value
	}
}

func truncateAccountErrorString(value string) string {
	if len(value) <= accountErrorTextLimit {
		return value
	}
	return value[:accountErrorTextLimit] + "...[truncated, " + strconv.Itoa(len(value)) + " chars total]"
}

func summarizeToolsForError(tools []any) string {
	names := []string{}
	limit := len(tools)
	if limit > accountErrorArrayPreviewLimit {
		limit = accountErrorArrayPreviewLimit
	}
	for _, tool := range tools[:limit] {
		toolMap, ok := tool.(map[string]any)
		if !ok {
			continue
		}
		if fn, ok := toolMap["function"].(map[string]any); ok {
			if name, ok := fn["name"].(string); ok {
				names = append(names, name)
			}
			continue
		}
		if name, ok := toolMap["name"].(string); ok {
			names = append(names, name)
		}
	}
	suffix := ""
	if len(tools) > accountErrorArrayPreviewLimit {
		suffix = ", +" + strconv.Itoa(len(tools)-accountErrorArrayPreviewLimit) + " more"
	}
	return "[" + strconv.Itoa(len(tools)) + " tool(s): " + strings.Join(names, ", ") + suffix + "]"
}

func summarizeMessagesForError(messages any) string {
	items, ok := messages.([]any)
	if !ok {
		return ""
	}
	limit := len(items)
	if limit > accountErrorMessageLimit {
		limit = accountErrorMessageLimit
	}
	entries := make([]map[string]any, 0, limit+1)
	for i := 0; i < limit; i++ {
		entry := map[string]any{"index": i}
		if obj, ok := items[i].(map[string]any); ok {
			keys := make([]string, 0, len(obj))
			for key := range obj {
				keys = append(keys, key)
			}
			sort.Strings(keys)
			entry["keys"] = keys
		} else if _, ok := items[i].([]any); ok {
			entry["type"] = "array"
		} else {
			entry["type"] = typeNameForError(items[i])
		}
		entries = append(entries, entry)
	}
	if len(items) > accountErrorMessageLimit {
		entries = append(entries, map[string]any{"index": accountErrorMessageLimit, "type": "truncated_" + strconv.Itoa(len(items)-accountErrorMessageLimit) + "_more_items"})
	}
	data, err := json.MarshalIndent(entries, "", "  ")
	if err != nil {
		return "[unserializable message summary]"
	}
	return string(data)
}

func typeNameForError(value any) string {
	switch value.(type) {
	case nil:
		return "null"
	case string:
		return "string"
	case bool:
		return "boolean"
	case float64, float32, int, int64, int32:
		return "number"
	default:
		return "object"
	}
}

func endpointPath(endpoint string) string {
	switch endpoint {
	case "chat_completions":
		return "/v1/chat/completions"
	case "messages":
		return "/v1/messages"
	case "responses":
		return "/v1/responses"
	default:
		return "/" + strings.TrimLeft(endpoint, "/")
	}
}
