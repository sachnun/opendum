package freebuff

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const buffySystemPromptOpening = "You are Buffy, the strategic coding assistant."

var freeTierApprovedToolNames = map[string]struct{}{
	"spawn_agents":      {},
	"read_files":        {},
	"read_subtree":      {},
	"write_todos":       {},
	"suggest_followups": {},
	"str_replace":       {},
	"ask_user":          {},
	"read_url":          {},
	"set_output":        {},
	"list_directory":    {},
	"render_ui":         {},
	"gravity_index":     {},
}

func BuildChatBody(payload map[string]any, model, runID, instanceID, clientID string, step int) ([]byte, error) {
	cloned := cloneMap(payload)
	cloned["model"] = model

	if tools, ok := cloned["tools"].([]any); ok {
		normalizeToolSchemas(tools)
		if !hasApprovedFreeTierTool(tools) {
			cloned["tools"] = append(tools, freeTierGateDecoyTool())
		}
	}
	if messages, ok := cloned["messages"].([]any); ok {
		cloned["messages"] = normalizeChatMessages(messages)
	}

	delete(cloned, "codebuff")
	delete(cloned, "provider")

	if _, ok := cloned["stream"]; !ok {
		cloned["stream"] = true
	}
	if _, ok := cloned["stop"]; !ok {
		cloned["stop"] = []string{"cb_easp"}
	}

	metadata, _ := cloned["codebuff_metadata"].(map[string]any)
	if metadata == nil {
		metadata = map[string]any{}
	}
	metadata["run_id"] = runID
	metadata["cost_mode"] = "free"
	metadata["client_id"] = clientID
	if step > 0 {
		metadata["n"] = step
	}
	if strings.TrimSpace(instanceID) != "" {
		metadata["freebuff_instance_id"] = strings.TrimSpace(instanceID)
	}
	cloned["codebuff_metadata"] = metadata

	cloned["provider"] = map[string]any{"allow_fallbacks": !strings.HasPrefix(model, "openrouter/")}

	return json.Marshal(cloned)
}

func normalizeChatMessages(messages []any) []any {
	normalized := make([]any, 0, len(messages)+1)
	for _, raw := range messages {
		msg, ok := raw.(map[string]any)
		if !ok {
			normalized = append(normalized, raw)
			continue
		}
		item := cloneMap(msg)
		if role, _ := item["role"].(string); role == "developer" {
			item["role"] = "system"
		}
		normalized = append(normalized, item)
	}
	buffy := map[string]any{
		"role":    "system",
		"content": buffySystemPromptOpening + " You are the AI agent behind the product, Freebuff, a tool where users can chat with you to code with AI for free.",
	}
	result := make([]any, 0, len(normalized)+1)
	result = append(result, buffy)
	result = append(result, normalized...)
	return result
}

func hasApprovedFreeTierTool(tools []any) bool {
	for _, tool := range tools {
		toolMap, ok := tool.(map[string]any)
		if !ok {
			continue
		}
		fn, ok := toolMap["function"].(map[string]any)
		if !ok {
			continue
		}
		name, _ := fn["name"].(string)
		if _, approved := freeTierApprovedToolNames[name]; approved {
			return true
		}
	}
	return false
}

func freeTierGateDecoyTool() map[string]any {
	return map[string]any{
		"type": "function",
		"function": map[string]any{
			"name": "set_output",
			"description": "Internal reporting channel reserved for spawned subagents to return their final result to the orchestrator. " +
				"This tool is managed by the system and must never be called directly.",
			"parameters": map[string]any{"type": "object", "properties": map[string]any{}, "additionalProperties": false},
		},
	}
}

func normalizeToolSchemas(tools []any) {
	for _, tool := range tools {
		toolMap, ok := tool.(map[string]any)
		if !ok {
			continue
		}
		fn, ok := toolMap["function"].(map[string]any)
		if !ok {
			continue
		}
		if name, ok := fn["name"].(string); ok {
			fn["name"] = sanitizeToolName(name)
		}
	}
}

func sanitizeToolName(name string) string {
	var b strings.Builder
	for _, r := range name {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_' || r == '-' {
			b.WriteRune(r)
		} else {
			b.WriteRune('_')
		}
	}
	if b.Len() == 0 {
		return "unnamed_tool"
	}
	return b.String()
}

func IsSessionInvalid(statusCode int, errorBody []byte) bool {
	if statusCode == 426 {
		return true
	}
	if statusCode < 400 {
		return false
	}
	_, _, code := extractUpstreamError(errorBody)
	switch strings.TrimSpace(code) {
	case "freebuff_update_required", "waiting_room_required", "waiting_room_queued",
		"session_superseded", "session_expired", "session_model_mismatch",
		"free_mode_invalid_agent_hierarchy", "free_mode_cli_required":
		return true
	default:
		return false
	}
}

func isDailyFreeModelQuotaError(message string) bool {
	lower := strings.ToLower(message)
	return strings.Contains(lower, "free-models-per-day") ||
		strings.Contains(lower, "high-balance") ||
		strings.Contains(lower, "daily free model")
}

func isTurnEndLimitError(message, code string) bool {
	lower := strings.ToLower(message + " " + code)
	return strings.Contains(lower, "turn_spend_limit") || strings.Contains(lower, "turn_end_limit") || strings.Contains(lower, "turn end limit")
}

// IsTurnLimit reports whether the upstream ended the run's turn budget, in
// which case rotating the run lets the next request continue.
func IsTurnLimit(statusCode int, errorBody []byte) bool {
	if statusCode < 400 {
		return false
	}
	message, _, code := extractUpstreamError(errorBody)
	return isTurnEndLimitError(message, code)
}

// CapacityDeferredRetry reports the wait the upstream asked for before retrying
// a free_mode_capacity_deferred rejection.
func CapacityDeferredRetry(statusCode int, header http.Header, errorBody []byte) (time.Duration, bool) {
	if statusCode != http.StatusTooManyRequests {
		return 0, false
	}
	message, _, code := extractUpstreamError(errorBody)
	if !strings.Contains(strings.ToLower(message+" "+code), "free_mode_capacity_deferred") {
		return 0, false
	}
	delay := parseRetryAfter(header)
	if delay <= 0 {
		delay = capacityDeferredCooldown
	}
	if delay > retryAfterCap {
		delay = retryAfterCap
	}
	return delay, true
}

// DailyQuotaCooldown reports how long the account must be parked when its daily
// free-model quota is exhausted, which retrying or rejoining cannot fix.
func DailyQuotaCooldown(statusCode int, errorBody []byte) (time.Duration, bool) {
	if statusCode < 400 {
		return 0, false
	}
	message, _, code := extractUpstreamError(errorBody)
	if !isDailyFreeModelQuotaError(message + " " + code) {
		return 0, false
	}
	return dailyQuotaCooldown, true
}

func extractUpstreamError(body []byte) (message, errorType, code string) {
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		return strings.TrimSpace(string(body)), "upstream_error", ""
	}
	errorType = "upstream_error"
	if rawError, ok := payload["error"]; ok {
		switch typed := rawError.(type) {
		case string:
			code = typed
		case map[string]any:
			if value, ok := typed["message"].(string); ok && strings.TrimSpace(value) != "" {
				message = value
			}
			if value, ok := typed["type"].(string); ok && strings.TrimSpace(value) != "" {
				errorType = value
			}
			if value, ok := typed["code"].(string); ok && strings.TrimSpace(value) != "" {
				code = value
			}
			if value, ok := typed["code"].(float64); ok && value > 0 {
				code = strconv.FormatInt(int64(value), 10)
			}
		}
	}
	if value, ok := payload["message"].(string); ok && strings.TrimSpace(value) != "" {
		message = value
	}
	if message == "" {
		message = strings.TrimSpace(string(body))
	}
	return message, errorType, code
}

func cloneMap(input map[string]any) map[string]any {
	out := make(map[string]any, len(input))
	for key, value := range input {
		out[key] = cloneValue(value)
	}
	return out
}

func cloneValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		return cloneMap(typed)
	case []any:
		cloned := make([]any, len(typed))
		for i := range typed {
			cloned[i] = cloneValue(typed[i])
		}
		return cloned
	default:
		return value
	}
}
