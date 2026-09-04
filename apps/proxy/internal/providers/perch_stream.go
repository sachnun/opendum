package providers

import (
	"bufio"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
)

// perchSSEToChatSSEReader translates the Perch model-call SSE stream into an
// OpenAI chat.completion.chunk SSE stream. Perch events mirror the CLI wire
// format: reasoning_delta / answer_delta text deltas, tool_call_delta and
// tool_use_end tool-call events, and a terminal done event carrying usage.
func perchSSEToChatSSEReader(source io.Reader, model string, includeReasoning bool) io.Reader {
	reader, writer := io.Pipe()
	go func() {
		transformPerchSSEToChat(source, writer, model, includeReasoning)
		_ = writer.Close()
	}()
	return reader
}

type perchStreamTool struct {
	index       int
	name        string
	emittedArgs bool
}

func perchWriteChunk(writer io.Writer, completionID, model string, delta map[string]any, finish any, usage map[string]any) {
	chunk := map[string]any{
		"id":      completionID,
		"object":  "chat.completion.chunk",
		"created": time.Now().Unix(),
		"model":   model,
		"choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": finish}},
	}
	if usage != nil {
		chunk["usage"] = usage
	}
	encoded, _ := json.Marshal(chunk)
	_, _ = writer.Write([]byte("data: " + string(encoded) + "\n\n"))
}

func perchToolDeltaChunk(writer io.Writer, completionID, model string, index int, withID bool, id string, withName bool, name string, arguments string) {
	toolDelta := map[string]any{"index": index}
	function := map[string]any{}
	if withID {
		toolDelta["id"] = id
		toolDelta["type"] = "function"
	}
	if withName {
		function["name"] = name
	}
	if arguments != "" {
		function["arguments"] = arguments
	}
	toolDelta["function"] = function
	perchWriteChunk(writer, completionID, model, map[string]any{"tool_calls": []any{toolDelta}}, nil, nil)
}

func transformPerchSSEToChat(source io.Reader, writer io.Writer, model string, includeReasoning bool) {
	completionID := randomID("chatcmpl")
	sentRole := false
	nextToolIndex := 0
	tools := map[string]*perchStreamTool{}

	scanner := bufio.NewScanner(source)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || line == "[DONE]" || strings.HasPrefix(line, ":") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "" || payload == "[DONE]" {
			continue
		}
		var event map[string]any
		if err := json.Unmarshal([]byte(payload), &event); err != nil {
			continue
		}
		switch stringValue(event["type"]) {
		case "reasoning_delta":
			if !includeReasoning {
				continue
			}
			perchEnsureRole(writer, completionID, model, &sentRole)
			if delta := stringValue(event["text"]); delta != "" {
				perchWriteChunk(writer, completionID, model, map[string]any{"reasoning_content": delta}, nil, nil)
			}
		case "answer_delta":
			perchEnsureRole(writer, completionID, model, &sentRole)
			if delta := stringValue(event["text"]); delta != "" {
				perchWriteChunk(writer, completionID, model, map[string]any{"content": delta}, nil, nil)
			}
		case "tool_call_delta", "tool_use_end":
			sealed := stringValue(event["type"]) == "tool_use_end"
			for _, rawCall := range perchEventToolCalls(event) {
				call, _ := rawCall.(map[string]any)
				id := stringValue(call["id"])
				if id == "" {
					continue
				}
				state, ok := tools[id]
				if !ok {
					perchEnsureRole(writer, completionID, model, &sentRole)
					name := stringValue(call["name"])
					state = &perchStreamTool{index: nextToolIndex, name: name}
					tools[id] = state
					nextToolIndex++
					perchToolDeltaChunk(writer, completionID, model, state.index, true, id, name != "", name, "")
				}
				if name := stringValue(call["name"]); name != "" && state.name == "" {
					state.name = name
					perchToolDeltaChunk(writer, completionID, model, state.index, false, "", true, name, "")
				}
				arguments := perchToolArgumentsDelta(call, sealed)
				if arguments == "" {
					continue
				}
				if sealed && state.emittedArgs {
					continue
				}
				state.emittedArgs = true
				perchToolDeltaChunk(writer, completionID, model, state.index, false, "", false, "", arguments)
			}
		case "done":
			ok, _ := event["ok"].(bool)
			if !ok {
				if message := perchErrorMessage(event); message != "" {
					perchEnsureRole(writer, completionID, model, &sentRole)
					perchWriteChunk(writer, completionID, model, map[string]any{"content": message}, nil, nil)
				}
			}
			finish := "stop"
			if len(tools) > 0 && ok {
				finish = "tool_calls"
			}
			perchWriteChunk(writer, completionID, model, map[string]any{}, finish, perchUsageToChatUsage(event["usage"]))
			_, _ = writer.Write([]byte("data: [DONE]\n\n"))
			return
		default:
			continue
		}
	}
	perchWriteChunk(writer, completionID, model, map[string]any{}, "stop", nil)
	_, _ = writer.Write([]byte("data: [DONE]\n\n"))
}

func perchEnsureRole(writer io.Writer, completionID, model string, sentRole *bool) {
	if *sentRole {
		return
	}
	perchWriteChunk(writer, completionID, model, map[string]any{"role": "assistant", "content": ""}, nil, nil)
	*sentRole = true
}

// perchSSEToChatCompletion buffers a full Perch SSE stream and synthesizes a
// single OpenAI chat.completion object for non-streaming requests.
func perchSSEToChatCompletion(source io.Reader, model string, includeReasoning bool) (map[string]any, error) {
	var content, reasoning strings.Builder
	toolCalls := []any{}
	finishReason := "stop"
	var usage map[string]any

	type bufferedTool struct {
		id   string
		name string
		args strings.Builder
	}
	var orderedTools []*bufferedTool
	byID := map[string]*bufferedTool{}
	ensureTool := func(id, name string) *bufferedTool {
		if tool, ok := byID[id]; ok {
			if name != "" && tool.name == "" {
				tool.name = name
			}
			return tool
		}
		tool := &bufferedTool{id: id, name: name}
		byID[id] = tool
		orderedTools = append(orderedTools, tool)
		return tool
	}

	scanner := bufio.NewScanner(source)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || line == "[DONE]" || strings.HasPrefix(line, ":") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "" || payload == "[DONE]" {
			continue
		}
		var event map[string]any
		if err := json.Unmarshal([]byte(payload), &event); err != nil {
			continue
		}
		switch stringValue(event["type"]) {
		case "reasoning_delta":
			if includeReasoning {
				if delta := stringValue(event["text"]); delta != "" {
					reasoning.WriteString(delta)
				}
			}
		case "answer_delta":
			if delta := stringValue(event["text"]); delta != "" {
				content.WriteString(delta)
			}
		case "tool_call_delta", "tool_use_end":
			sealed := stringValue(event["type"]) == "tool_use_end"
			for _, rawCall := range perchEventToolCalls(event) {
				call, _ := rawCall.(map[string]any)
				id := stringValue(call["id"])
				if id == "" {
					continue
				}
				tool := ensureTool(id, stringValue(call["name"]))
				if sealed {
					if arguments := perchToolSealedArguments(call); arguments != "" {
						tool.args.Reset()
						tool.args.WriteString(arguments)
					}
				} else if delta := stringValue(call["rawArgumentsText"]); delta != "" {
					tool.args.WriteString(delta)
				}
			}
		case "done":
			message := perchErrorMessage(event)
			ok, hasOK := event["ok"].(bool)
			if message != "" || (hasOK && !ok) {
				if message == "" {
					message = "Perch request failed"
				}
				return nil, &perchUpstreamError{Message: message, Quota: perchQuotaError(message)}
			}
			usage = perchUsageToChatUsage(event["usage"])
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}

	for _, tool := range orderedTools {
		arguments := tool.args.String()
		if strings.TrimSpace(arguments) == "" {
			arguments = "{}"
		}
		toolCalls = append(toolCalls, map[string]any{
			"id":       tool.id,
			"type":     "function",
			"function": map[string]any{"name": tool.name, "arguments": arguments},
		})
	}

	message := map[string]any{"role": "assistant", "content": nil}
	if text := content.String(); text != "" {
		message["content"] = text
	}
	if includeReasoning {
		if text := reasoning.String(); text != "" {
			message["reasoning_content"] = text
		}
	}
	if len(toolCalls) > 0 {
		message["tool_calls"] = toolCalls
		finishReason = "tool_calls"
	}
	if usage == nil {
		usage = map[string]any{"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
	}

	return map[string]any{
		"id":      randomID("chatcmpl"),
		"object":  "chat.completion",
		"created": time.Now().Unix(),
		"model":   model,
		"choices": []any{map[string]any{"index": 0, "message": message, "finish_reason": finishReason}},
		"usage":   usage,
	}, nil
}

func perchEventToolCalls(event map[string]any) []any {
	if value, ok := event["toolCalls"].([]any); ok {
		return value
	}
	if value, ok := event["tool_calls"].([]any); ok {
		return value
	}
	return nil
}

// perchToolArgumentsDelta returns the argument text for a streaming chunk:
// raw streamed text while open, and the sealed JSON arguments object at close.
func perchToolArgumentsDelta(call map[string]any, sealed bool) string {
	if raw := stringValue(call["rawArgumentsText"]); raw != "" {
		return raw
	}
	if sealed {
		return perchToolSealedArguments(call)
	}
	return ""
}

func perchToolSealedArguments(call map[string]any) string {
	if text := stringValue(call["arguments"]); text != "" {
		return text
	}
	if arguments := call["arguments"]; arguments != nil {
		encoded, _ := json.Marshal(arguments)
		return string(encoded)
	}
	return ""
}

func perchErrorMessage(event map[string]any) string {
	if text := stringValue(event["error"]); text != "" {
		return text
	}
	if value := event["error"]; value != nil {
		encoded, _ := json.Marshal(value)
		return string(encoded)
	}
	return ""
}

type perchUpstreamError struct {
	Message string
	Quota   bool
}

func (e *perchUpstreamError) Error() string {
	return e.Message
}

func perchErrorStatus(err *perchUpstreamError) int {
	if err.Quota {
		return http.StatusTooManyRequests
	}
	return http.StatusBadGateway
}

func perchErrorType(err *perchUpstreamError) string {
	if err.Quota {
		return "rate_limit_error"
	}
	return "api_error"
}

func perchQuotaError(message string) bool {
	lower := strings.ToLower(message)
	for _, marker := range []string{"allowance", "quota", "limit", "usage", "billing", "credit"} {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}

func perchUsageToChatUsage(raw any) map[string]any {
	usage, _ := raw.(map[string]any)
	if usage == nil {
		return nil
	}
	input := perchUsageInt(usage, "inputTokens")
	output := perchUsageInt(usage, "outputTokens")
	cacheRead := perchUsageInt(usage, "cacheReadInputTokens")
	if input == 0 && output == 0 && cacheRead == 0 {
		return nil
	}
	promptTokens := input + cacheRead
	return map[string]any{"prompt_tokens": promptTokens, "completion_tokens": output, "total_tokens": promptTokens + output}
}

func perchUsageInt(usage map[string]any, key string) int {
	if value, ok := usage[key].(float64); ok && value > 0 {
		return int(value)
	}
	return 0
}
