package providers

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
)

type groqErrorResponse struct {
	Error struct {
		Code             string `json:"code"`
		FailedGeneration any    `json:"failed_generation"`
	} `json:"error"`
}

type groqRecoveredToolCall struct {
	Name      string
	Arguments string
}

func filterGroqPayload(payload map[string]any, modelName string) {
	rawEffort, exists := payload["reasoning_effort"]
	if !exists {
		return
	}
	effort := strings.ToLower(strings.TrimSpace(stringValue(rawEffort)))
	if effort == "" || !isGroqReasoningEffortSupported(modelName, effort) {
		delete(payload, "reasoning_effort")
		return
	}
	payload["reasoning_effort"] = effort
}

func isGroqReasoningEffortSupported(modelName, effort string) bool {
	switch strings.TrimSpace(modelName) {
	case "openai/gpt-oss-20b", "openai/gpt-oss-120b", "gpt-oss-20b", "gpt-oss-120b":
		return effort == "low" || effort == "medium" || effort == "high"
	case "qwen/qwen3-32b", "qwen3-32b":
		return effort == "none" || effort == "default"
	default:
		return false
	}
}

func (p openAICompatibleProvider) recoverGroqToolUseFailed(resp *http.Response, modelName string) (*http.Response, error) {
	body := readLimit(resp.Body, 1<<20)
	_ = resp.Body.Close()
	completion, ok := groqToolUseFailedCompletion(body, modelName)
	if ok {
		return jsonResponse(http.StatusOK, completion), nil
	}
	return &http.Response{StatusCode: resp.StatusCode, Status: resp.Status, Header: resp.Header.Clone(), Body: io.NopCloser(strings.NewReader(body))}, nil
}

func groqToolUseFailedCompletion(body, modelName string) (map[string]any, bool) {
	var parsed groqErrorResponse
	if json.Unmarshal([]byte(strings.TrimSpace(body)), &parsed) != nil {
		return nil, false
	}
	if strings.TrimSpace(parsed.Error.Code) != "tool_use_failed" {
		return nil, false
	}
	failedGeneration := groqFailedGenerationText(parsed.Error.FailedGeneration)
	if failedGeneration == "" {
		return nil, false
	}
	if call, ok := parseGroqFailedToolCall(failedGeneration); ok {
		return groqSyntheticChatCompletion(modelName, map[string]any{
			"role":    "assistant",
			"content": nil,
			"tool_calls": []any{map[string]any{
				"id":   randomID("call"),
				"type": "function",
				"function": map[string]any{
					"name":      call.Name,
					"arguments": call.Arguments,
				},
			}},
		}, "tool_calls"), true
	}
	return groqSyntheticChatCompletion(modelName, map[string]any{"role": "assistant", "content": failedGeneration}, "stop"), true
}

func groqFailedGenerationText(value any) string {
	if text, ok := value.(string); ok {
		return strings.TrimSpace(text)
	}
	if value == nil {
		return ""
	}
	data, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

func groqSyntheticChatCompletion(modelName string, message map[string]any, finishReason string) map[string]any {
	return map[string]any{
		"id":      randomID("chatcmpl"),
		"object":  "chat.completion",
		"created": time.Now().Unix(),
		"model":   modelName,
		"choices": []any{map[string]any{
			"index":         0,
			"message":       message,
			"finish_reason": finishReason,
		}},
		"usage": map[string]any{"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
	}
}

func parseGroqFailedToolCall(raw string) (groqRecoveredToolCall, bool) {
	text := strings.TrimSpace(raw)
	fallbackName := ""
	if strings.HasPrefix(text, "<function=") {
		fallbackName, text = splitGroqFunctionTag(text)
	}
	return parseGroqToolCallJSON(text, fallbackName)
}

func splitGroqFunctionTag(text string) (string, string) {
	rest := strings.TrimPrefix(text, "<function=")
	nameEnd := len(rest)
	for i, r := range rest {
		if r == '>' || r == '{' || r == '`' || r == ' ' || r == '\n' || r == '\r' || r == '\t' {
			nameEnd = i
			break
		}
	}
	name := strings.TrimSpace(rest[:nameEnd])
	remainder := rest[nameEnd:]
	if strings.HasPrefix(remainder, ">") {
		remainder = remainder[1:]
	}
	if end := strings.LastIndex(remainder, "</function>"); end >= 0 {
		remainder = remainder[:end]
	}
	return name, cleanGroqToolCallJSONText(remainder)
}

func parseGroqToolCallJSON(text, fallbackName string) (groqRecoveredToolCall, bool) {
	text = cleanGroqToolCallJSONText(text)
	if text == "" {
		return groqRecoveredToolCall{}, false
	}
	var obj map[string]any
	if err := json.Unmarshal([]byte(text), &obj); err != nil {
		extracted, ok := firstJSONObject(text)
		if !ok || json.Unmarshal([]byte(extracted), &obj) != nil {
			return groqRecoveredToolCall{}, false
		}
	}
	return groqToolCallFromMap(obj, fallbackName)
}

func cleanGroqToolCallJSONText(text string) string {
	text = strings.TrimSpace(text)
	text = strings.Trim(text, "`")
	text = strings.TrimSpace(text)
	if strings.HasPrefix(text, "```") {
		text = strings.TrimPrefix(text, "```")
		if newline := strings.IndexByte(text, '\n'); newline >= 0 {
			text = text[newline+1:]
		}
		if end := strings.LastIndex(text, "```"); end >= 0 {
			text = text[:end]
		}
		text = strings.TrimSpace(text)
	}
	return text
}

func groqToolCallFromMap(obj map[string]any, fallbackName string) (groqRecoveredToolCall, bool) {
	if calls, ok := obj["tool_calls"].([]any); ok && len(calls) > 0 {
		call, _ := calls[0].(map[string]any)
		if fn, ok := call["function"].(map[string]any); ok {
			return groqToolCallFromFunction(fn, fallbackName)
		}
	}
	if fn, ok := obj["function"].(map[string]any); ok {
		if call, ok := groqToolCallFromFunction(fn, fallbackName); ok {
			return call, true
		}
	}

	name := strings.TrimSpace(defaultStringValue(obj["name"], fallbackName))
	arguments, hasArguments := obj["arguments"]
	if !hasArguments {
		arguments, hasArguments = obj["parameters"]
	}
	if !hasArguments && fallbackName != "" {
		argsMap := cloneAnyMap(obj)
		for _, key := range []string{"name", "type", "function", "tool_calls"} {
			delete(argsMap, key)
		}
		arguments = argsMap
		hasArguments = true
	}
	if name == "" || !hasArguments {
		return groqRecoveredToolCall{}, false
	}
	return groqRecoveredToolCall{Name: name, Arguments: groqArgumentsJSON(arguments)}, true
}

func groqToolCallFromFunction(fn map[string]any, fallbackName string) (groqRecoveredToolCall, bool) {
	name := strings.TrimSpace(defaultStringValue(fn["name"], fallbackName))
	if name == "" {
		return groqRecoveredToolCall{}, false
	}
	arguments, ok := fn["arguments"]
	if !ok {
		arguments = fn["parameters"]
	}
	return groqRecoveredToolCall{Name: name, Arguments: groqArgumentsJSON(arguments)}, true
}

func groqArgumentsJSON(value any) string {
	switch typed := value.(type) {
	case nil:
		return "{}"
	case string:
		text := strings.TrimSpace(typed)
		if text == "" {
			return "{}"
		}
		if json.Valid([]byte(text)) {
			return text
		}
		data, _ := json.Marshal(map[string]any{"value": typed})
		return string(data)
	default:
		data, err := json.Marshal(typed)
		if err != nil {
			return "{}"
		}
		return string(data)
	}
}

func firstJSONObject(text string) (string, bool) {
	start := strings.IndexByte(text, '{')
	if start < 0 {
		return "", false
	}
	depth := 0
	inString := false
	escaped := false
	for i := start; i < len(text); i++ {
		ch := text[i]
		if inString {
			if escaped {
				escaped = false
				continue
			}
			if ch == '\\' {
				escaped = true
				continue
			}
			if ch == '"' {
				inString = false
			}
			continue
		}
		switch ch {
		case '"':
			inString = true
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return text[start : i+1], true
			}
		}
	}
	return "", false
}
