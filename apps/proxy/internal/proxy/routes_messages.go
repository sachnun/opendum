package proxy

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
)

type requestBodyContextKey struct{}

func messagesConfig(s *Service) routeConfig {
	return routeConfig{
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

func parseMessages(body map[string]any) (parsedRequest, *routeError) {
	model, _ := body["model"].(string)
	model = strings.TrimSpace(model)
	if model == "" {
		return parsedRequest{}, &routeError{Status: http.StatusBadRequest, Message: "model is required", Type: "invalid_request_error"}
	}
	stream := true
	if value, ok := body["stream"].(bool); ok {
		stream = value
	}
	var providerAccountID *string
	if value, ok := body["provider_account_id"].(string); ok {
		providerAccountID = &value
	}
	paramsForError := cloneMapExcept(body, "model", "messages", "stream", "provider_account_id")
	paramsForError["stream"] = stream
	if providerAccountID != nil && *providerAccountID != "" {
		paramsForError["provider_account_id"] = *providerAccountID
	}
	return parsedRequest{ModelParam: model, Stream: stream, ProviderAccountID: providerAccountID, MessagesForError: body["messages"], ParamsForError: paramsForError, RouteData: map[string]any{"body": body}}, nil
}

func buildMessages(parsed parsedRequest, model string, stream bool, sessionID string) map[string]any {
	body, _ := parsed.RouteData["body"].(map[string]any)
	payload := transformAnthropicToOpenAI(body)
	payload["model"] = model
	payload["stream"] = stream
	if sessionID != "" {
		payload["_sessionId"] = sessionID
	}
	return payload
}

func transformAnthropicToOpenAI(body map[string]any) map[string]any {
	payload := cloneMapExcept(body, "system", "provider_account_id")
	messages := []any{}
	if system := body["system"]; system != nil {
		messages = append(messages, map[string]any{"role": "system", "content": anthropicSystemToText(system)})
	}
	if rawMessages, ok := body["messages"].([]any); ok {
		for _, raw := range rawMessages {
			msg, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			role := stringValue(msg["role"])
			content := msg["content"]
			switch typed := content.(type) {
			case string:
				messages = append(messages, map[string]any{"role": role, "content": typed})
			case []any:
				converted := convertAnthropicContentBlocks(typed)
				for _, item := range converted.extraMessages {
					messages = append(messages, item)
				}
				if len(converted.parts) > 0 || len(converted.toolCalls) > 0 {
					message := map[string]any{"role": role, "content": converted.contentValue()}
					if len(converted.toolCalls) > 0 {
						message["tool_calls"] = converted.toolCalls
					}
					messages = append(messages, message)
				}
			}
		}
	}
	payload["messages"] = messages
	if maxTokens, ok := body["max_tokens"]; ok {
		payload["max_tokens"] = maxTokens
	}
	if thinking, ok := body["thinking"].(map[string]any); ok && thinking["type"] == "enabled" {
		if thinking["budget_tokens"] == nil {
			payload["thinking_budget"] = 10000
		} else {
			payload["thinking_budget"] = thinking["budget_tokens"]
		}
		payload["_includeReasoning"] = true
	}
	return payload
}

type convertedBlocks struct {
	parts         []any
	toolCalls     []any
	extraMessages []any
}

func (c convertedBlocks) contentValue() any {
	if len(c.parts) == 0 {
		return nil
	}
	textOnly := true
	texts := []string{}
	for _, raw := range c.parts {
		part, ok := raw.(map[string]any)
		if !ok || part["type"] != "text" {
			textOnly = false
			break
		}
		texts = append(texts, stringValue(part["text"]))
	}
	if textOnly {
		return strings.Join(texts, "")
	}
	return c.parts
}

func convertAnthropicContentBlocks(blocks []any) convertedBlocks {
	result := convertedBlocks{}
	for _, raw := range blocks {
		block, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		switch stringValue(block["type"]) {
		case "text":
			if text := stringValue(block["text"]); text != "" {
				result.parts = append(result.parts, map[string]any{"type": "text", "text": text})
			}
		case "image":
			if source, ok := block["source"].(map[string]any); ok {
				if url := stringValue(source["url"]); url != "" {
					result.parts = append(result.parts, map[string]any{"type": "image_url", "image_url": map[string]any{"url": url}})
				}
			}
		case "tool_use":
			input := block["input"]
			args := "{}"
			if input != nil {
				data, _ := json.Marshal(input)
				args = string(data)
			}
			result.toolCalls = append(result.toolCalls, map[string]any{"id": stringValue(block["id"]), "type": "function", "function": map[string]any{"name": stringValue(block["name"]), "arguments": args}})
		case "tool_result":
			result.extraMessages = append(result.extraMessages, map[string]any{"role": "tool", "tool_call_id": stringValue(block["tool_use_id"]), "content": anthropicToolResultToText(block["content"])})
		}
	}
	return result
}

func (s *Service) anthropicNonStream(ctx nonStreamContext) error {
	body, err := io.ReadAll(ctx.Response.Body)
	if err != nil {
		return err
	}
	var openAI map[string]any
	_ = json.Unmarshal(body, &openAI)
	response := transformOpenAIToAnthropic(openAI, ctx.Model, includeThinking(ctx.Request))
	inputTokens, outputTokens := usageFromJSON(openAI)
	s.markAccountSuccess(context.Background(), ctx.AccountID, ctx.Model)
	s.recordLatency(context.Background(), ctx.Provider, ctx.Model, false, time.Now().UnixMilli()-ctx.RequestStartMS)
	s.logUsage(context.Background(), usageParams{UserID: ctx.UserID, ProviderAccountID: ctx.AccountID, ProxyAPIKeyID: ctx.APIKeyID, Model: ctx.Model, InputTokens: inputTokens, OutputTokens: outputTokens, StatusCode: http.StatusOK, DurationMS: int(time.Now().UnixMilli() - ctx.StartMS), Provider: ctx.Provider})
	ctx.Writer.Header().Set("Content-Type", "application/json")
	ctx.Writer.Header().Set("X-Provider-Account-Id", ctx.AccountID)
	ctx.Writer.WriteHeader(http.StatusOK)
	return json.NewEncoder(ctx.Writer).Encode(response)
}

func transformOpenAIToAnthropic(openAI map[string]any, model string, includeThinking bool) map[string]any {
	content := []any{}
	choices, _ := openAI["choices"].([]any)
	stopReason := "end_turn"
	if len(choices) > 0 {
		choice, _ := choices[0].(map[string]any)
		message, _ := choice["message"].(map[string]any)
		if includeThinking {
			if reasoning := stringValue(message["reasoning_content"]); reasoning != "" {
				content = append(content, map[string]any{"type": "thinking", "thinking": reasoning})
			}
		}
		if text := stringValue(message["content"]); text != "" {
			content = append(content, map[string]any{"type": "text", "text": text})
		}
		if calls, ok := message["tool_calls"].([]any); ok {
			for _, raw := range calls {
				call, _ := raw.(map[string]any)
				fn, _ := call["function"].(map[string]any)
				var input map[string]any
				_ = json.Unmarshal([]byte(defaultStringValue(fn["arguments"], "{}")), &input)
				content = append(content, map[string]any{"type": "tool_use", "id": stringValue(call["id"]), "name": stringValue(fn["name"]), "input": input})
			}
			if len(calls) > 0 {
				stopReason = "tool_use"
			}
		}
		if finish := stringValue(choice["finish_reason"]); finish == "length" {
			stopReason = "max_tokens"
		}
	}
	if len(content) == 0 {
		content = append(content, map[string]any{"type": "text", "text": ""})
	}
	inputTokens, outputTokens := usageFromJSON(openAI)
	return map[string]any{"id": "msg_" + defaultStringValue(openAI["id"], time.Now().Format("20060102150405")), "type": "message", "role": "assistant", "content": content, "model": model, "stop_reason": stopReason, "stop_sequence": nil, "usage": map[string]any{"input_tokens": inputTokens, "output_tokens": outputTokens}}
}

func (s *Service) anthropicStream(ctx streamContext) error {
	w := ctx.Writer
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.Header().Set("X-Provider-Account-Id", ctx.AccountID)
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)
	messageID := "msg_" + time.Now().Format("20060102150405")
	writeAnthropicEvent(w, flusher, "message_start", map[string]any{"type": "message_start", "message": map[string]any{"id": messageID, "type": "message", "role": "assistant", "content": []any{}, "model": ctx.Model, "stop_reason": nil, "stop_sequence": nil, "usage": map[string]any{"input_tokens": 0, "output_tokens": 0}}})
	tracker := &anthropicStreamTracker{writer: w, flusher: flusher, includeThinking: includeThinking(ctx.Request)}
	reader := bufio.NewReader(ctx.Response.Body)
	buf := make([]byte, 32*1024)
	for {
		n, err := reader.Read(buf)
		if n > 0 {
			tracker.Process(string(buf[:n]))
		}
		if err != nil {
			break
		}
	}
	tracker.Finish()
	s.markAccountSuccess(context.Background(), ctx.AccountID, ctx.Model)
	s.recordLatency(context.Background(), ctx.Provider, ctx.Model, true, time.Now().UnixMilli()-ctx.RequestStartMS)
	s.logUsage(context.Background(), usageParams{UserID: ctx.UserID, ProviderAccountID: ctx.AccountID, ProxyAPIKeyID: ctx.APIKeyID, Model: ctx.Model, InputTokens: tracker.inputTokens, OutputTokens: tracker.outputTokens, StatusCode: http.StatusOK, DurationMS: int(time.Now().UnixMilli() - ctx.StartMS), Provider: ctx.Provider})
	return nil
}

type anthropicStreamTracker struct {
	writer          http.ResponseWriter
	flusher         http.Flusher
	buffer          string
	blockStarted    bool
	blockIndex      int
	inputTokens     int
	outputTokens    int
	includeThinking bool
}

func (t *anthropicStreamTracker) Process(chunk string) {
	t.buffer += chunk
	events := strings.Split(t.buffer, "\n\n")
	t.buffer = events[len(events)-1]
	for _, event := range events[:len(events)-1] {
		for _, line := range strings.Split(event, "\n") {
			if !strings.HasPrefix(line, "data:") {
				continue
			}
			data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
			if data == "" || data == "[DONE]" {
				continue
			}
			var parsed map[string]any
			if json.Unmarshal([]byte(data), &parsed) != nil {
				continue
			}
			if usage, ok := parsed["usage"].(map[string]any); ok {
				if input := numberAsInt(usage["prompt_tokens"]); input > 0 {
					t.inputTokens = input
				}
				if output := numberAsInt(usage["completion_tokens"]); output > 0 {
					t.outputTokens = output
				}
			}
			choices, _ := parsed["choices"].([]any)
			if len(choices) == 0 {
				continue
			}
			choice, _ := choices[0].(map[string]any)
			delta, _ := choice["delta"].(map[string]any)
			if text := stringValue(delta["content"]); text != "" {
				if !t.blockStarted {
					writeAnthropicEvent(t.writer, t.flusher, "content_block_start", map[string]any{"type": "content_block_start", "index": t.blockIndex, "content_block": map[string]any{"type": "text", "text": ""}})
					t.blockStarted = true
				}
				writeAnthropicEvent(t.writer, t.flusher, "content_block_delta", map[string]any{"type": "content_block_delta", "index": t.blockIndex, "delta": map[string]any{"type": "text_delta", "text": text}})
			}
		}
	}
}

func (t *anthropicStreamTracker) Finish() {
	if t.blockStarted {
		writeAnthropicEvent(t.writer, t.flusher, "content_block_stop", map[string]any{"type": "content_block_stop", "index": t.blockIndex})
	}
	writeAnthropicEvent(t.writer, t.flusher, "message_delta", map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": "end_turn", "stop_sequence": nil}, "usage": map[string]any{"input_tokens": t.inputTokens, "output_tokens": t.outputTokens}})
	writeAnthropicEvent(t.writer, t.flusher, "message_stop", map[string]any{"type": "message_stop"})
}

func writeAnthropicEvent(w http.ResponseWriter, flusher http.Flusher, event string, data any) {
	payload, _ := json.Marshal(data)
	_, _ = w.Write([]byte("event: " + event + "\n" + "data: " + string(payload) + "\n\n"))
	if flusher != nil {
		flusher.Flush()
	}
}

func includeThinking(r *http.Request) bool {
	body, ok := r.Context().Value(requestBodyContextKey{}).(map[string]any)
	if !ok || body == nil {
		return false
	}
	thinking, ok := body["thinking"].(map[string]any)
	return ok && thinking["type"] == "enabled"
}

func anthropicSystemToText(value any) string {
	if str, ok := value.(string); ok {
		return str
	}
	if blocks, ok := value.([]any); ok {
		parts := []string{}
		for _, raw := range blocks {
			if block, ok := raw.(map[string]any); ok && block["type"] == "text" {
				parts = append(parts, stringValue(block["text"]))
			}
		}
		return strings.Join(parts, "\n")
	}
	return ""
}

func anthropicToolResultToText(value any) string {
	if str, ok := value.(string); ok {
		return str
	}
	data, _ := json.Marshal(value)
	return string(data)
}
