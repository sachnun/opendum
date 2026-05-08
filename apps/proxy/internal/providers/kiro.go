package providers

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
	"github.com/opendum/opendum/apps/proxy/internal/models"
)

const (
	kiroAPIBaseURL      = "https://q.us-east-1.amazonaws.com/generateAssistantResponse"
	kiroRefreshEndpoint = "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken"
)

type kiroProvider struct {
	registry *models.Registry
}

func (p kiroProvider) RefreshBuffer() time.Duration { return 5 * time.Minute }

func (p kiroProvider) RefreshCredentials(ctx context.Context, client *http.Client, refreshToken string, _ appdb.ProviderAccount) (RefreshedCredentials, error) {
	payload, _ := json.Marshal(map[string]any{"refreshToken": strings.TrimSpace(refreshToken)})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, kiroRefreshEndpoint, bytes.NewReader(payload))
	if err != nil {
		return RefreshedCredentials{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "KiroIDE")

	resp, err := client.Do(req)
	if err != nil {
		return RefreshedCredentials{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body := readLimit(resp.Body, 1<<20)
		return RefreshedCredentials{}, fmt.Errorf("kiro token refresh failed: %d %s", resp.StatusCode, body)
	}

	var token struct {
		AccessToken  string `json:"accessToken"`
		RefreshToken string `json:"refreshToken"`
		ExpiresIn    int64  `json:"expiresIn"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&token); err != nil {
		return RefreshedCredentials{}, err
	}
	if strings.TrimSpace(token.AccessToken) == "" {
		return RefreshedCredentials{}, fmt.Errorf("kiro token refresh returned empty access token")
	}
	if token.RefreshToken == "" {
		token.RefreshToken = refreshToken
	}
	if token.ExpiresIn <= 0 {
		token.ExpiresIn = 3600
	}
	return RefreshedCredentials{AccessToken: token.AccessToken, RefreshToken: token.RefreshToken, ExpiresAt: time.Now().Add(time.Duration(token.ExpiresIn) * time.Second)}, nil
}

func (p kiroProvider) MakeRequest(ctx context.Context, client *http.Client, credentials string, account appdb.ProviderAccount, body map[string]any, stream bool) (*http.Response, error) {
	modelName := lastModelSegment(stringValue(body["model"]))
	payload := p.buildRequest(body)
	if account.AccountID != nil && strings.TrimSpace(*account.AccountID) != "" {
		payload["profileArn"] = strings.TrimSpace(*account.AccountID)
	}

	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, kiroAPIBaseURL, bytes.NewReader(encoded))
	if err != nil {
		return nil, err
	}
	invocationID := randomID("kiro")
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(credentials))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "*/*")
	req.Header.Set("User-Agent", "KiroIDE-0.7.45")
	req.Header.Set("x-amz-user-agent", "KiroIDE-0.7.45")
	req.Header.Set("x-amzn-codewhisperer-optout", "true")
	req.Header.Set("x-amzn-kiro-agent-mode", "vibe")
	req.Header.Set("amz-sdk-invocation-id", invocationID)
	req.Header.Set("amz-sdk-request", "attempt=1; max=3")

	upstream, err := client.Do(req)
	if err != nil || upstream == nil || upstream.StatusCode < 200 || upstream.StatusCode >= 300 {
		return upstream, err
	}
	if upstream.Body == nil {
		return jsonResponse(http.StatusBadGateway, map[string]any{"error": map[string]any{"message": "Kiro response stream is empty", "type": "api_error"}}), nil
	}

	if stream {
		return sseResponse(newKiroSSEReader(upstream.Body, modelName), upstream.Body), nil
	}

	rawText, err := io.ReadAll(upstream.Body)
	_ = upstream.Body.Close()
	if err != nil {
		return nil, err
	}
	events := parseKiroJSONEvents(string(rawText), &kiroParserState{})
	return jsonResponse(http.StatusOK, convertKiroEventsToCompletion(events, modelName)), nil
}

func (p kiroProvider) buildRequest(body map[string]any) map[string]any {
	modelID := p.normalizeModel(stringValue(body["model"]))
	conversationID := randomID("conversation")
	tools := convertKiroTools(body["tools"])
	messages, _ := body["messages"].([]any)

	history := []any{}
	if len(messages) > 1 {
		for _, raw := range messages[:len(messages)-1] {
			if item := convertKiroMessageToHistoryItem(raw, modelID); item != nil {
				history = append(history, item)
			}
		}
	}

	currentContent := "Continue"
	currentContext := map[string]any{}
	if len(messages) > 0 {
		last, _ := messages[len(messages)-1].(map[string]any)
		role, _ := last["role"].(string)
		if role == "assistant" {
			if item := convertKiroMessageToHistoryItem(last, modelID); item != nil {
				history = append(history, item)
			}
		} else {
			currentContent = contentToText(last["content"])
			if currentContent == "" {
				currentContent = "Continue"
			}
			if role == "tool" {
				currentContext["toolResults"] = []any{map[string]any{"toolUseId": defaultStringValue(last["tool_call_id"], randomID("toolu")), "status": "success", "content": []any{map[string]any{"text": currentContent}}}}
			}
		}
	}
	if len(tools) > 0 {
		currentContext["tools"] = tools
	}
	if len(history) > 0 {
		if last, ok := history[len(history)-1].(map[string]any); ok {
			if _, ok := last["assistantResponseMessage"]; !ok {
				history = append(history, map[string]any{"assistantResponseMessage": map[string]any{"content": "Continue"}})
			}
		}
	}

	userInput := map[string]any{"content": currentContent, "modelId": modelID, "origin": "AI_EDITOR"}
	if len(currentContext) > 0 {
		userInput["userInputMessageContext"] = currentContext
	}
	conversationState := map[string]any{"chatTriggerType": "MANUAL", "conversationId": conversationID, "currentMessage": map[string]any{"userInputMessage": userInput}}
	if len(history) > 0 {
		conversationState["history"] = history
	}
	return map[string]any{"conversationState": conversationState}
}

func (p kiroProvider) normalizeModel(model string) string {
	raw := lastModelSegment(model)
	if p.registry == nil {
		return raw
	}
	upstream := p.registry.UpstreamModelName(raw, "kiro")
	return upstream
}

func convertKiroTools(raw any) []any {
	tools, _ := raw.([]any)
	result := []any{}
	for _, item := range tools {
		tool, _ := item.(map[string]any)
		if tool["type"] != "function" {
			continue
		}
		fn, _ := tool["function"].(map[string]any)
		name := strings.TrimSpace(stringValue(fn["name"]))
		if name == "" {
			continue
		}
		params, ok := fn["parameters"].(map[string]any)
		if !ok {
			params = map[string]any{"type": "object", "properties": map[string]any{}}
		}
		result = append(result, map[string]any{"toolSpecification": map[string]any{"name": name, "description": defaultStringValue(fn["description"], ""), "inputSchema": map[string]any{"json": params}}})
	}
	return result
}

func convertKiroMessageToHistoryItem(raw any, modelID string) map[string]any {
	message, _ := raw.(map[string]any)
	role, _ := message["role"].(string)
	if role == "assistant" {
		assistant := map[string]any{"content": contentToText(message["content"])}
		if calls, ok := message["tool_calls"].([]any); ok && len(calls) > 0 {
			toolUses := []any{}
			for _, rawCall := range calls {
				call, _ := rawCall.(map[string]any)
				fn, _ := call["function"].(map[string]any)
				id := stringValue(call["id"])
				name := stringValue(fn["name"])
				if id == "" || name == "" {
					continue
				}
				var input any = map[string]any{}
				if args := stringValue(fn["arguments"]); args != "" {
					_ = json.Unmarshal([]byte(args), &input)
				}
				toolUses = append(toolUses, map[string]any{"toolUseId": id, "name": name, "input": input})
			}
			if len(toolUses) > 0 {
				assistant["toolUses"] = toolUses
			}
		}
		return map[string]any{"assistantResponseMessage": assistant}
	}

	text := contentToText(message["content"])
	if role == "tool" {
		return map[string]any{"userInputMessage": map[string]any{"content": defaultEmpty(text, "Tool result provided."), "modelId": modelID, "origin": "AI_EDITOR", "userInputMessageContext": map[string]any{"toolResults": []any{map[string]any{"toolUseId": defaultStringValue(message["tool_call_id"], randomID("toolu")), "status": "success", "content": []any{map[string]any{"text": text}}}}}}}
	}
	if role == "user" || role == "system" || role == "developer" {
		return map[string]any{"userInputMessage": map[string]any{"content": defaultEmpty(text, "Continue"), "modelId": modelID, "origin": "AI_EDITOR"}}
	}
	return nil
}

func contentToText(content any) string {
	if text, ok := content.(string); ok {
		return text
	}
	parts, _ := content.([]any)
	chunks := []string{}
	for _, raw := range parts {
		part, _ := raw.(map[string]any)
		for _, key := range []string{"text", "input_text", "output_text"} {
			if value := stringValue(part[key]); value != "" {
				chunks = append(chunks, value)
				break
			}
		}
	}
	return strings.Join(chunks, "")
}

type kiroParserState struct{ buffer string }

func parseKiroJSONEvents(source string, state *kiroParserState) []map[string]any {
	state.buffer += source
	events := []map[string]any{}
	cursor := 0
	for cursor < len(state.buffer) {
		start := strings.Index(state.buffer[cursor:], "{")
		if start == -1 {
			state.buffer = ""
			return events
		}
		start += cursor
		depth := 0
		inString := false
		escaped := false
		end := -1
		for i := start; i < len(state.buffer); i++ {
			ch := state.buffer[i]
			if escaped {
				escaped = false
				continue
			}
			if ch == '\\' {
				escaped = true
				continue
			}
			if ch == '"' {
				inString = !inString
				continue
			}
			if inString {
				continue
			}
			if ch == '{' {
				depth++
			} else if ch == '}' {
				depth--
				if depth == 0 {
					end = i
					break
				}
			}
		}
		if end == -1 {
			state.buffer = state.buffer[start:]
			return events
		}
		candidate := state.buffer[start : end+1]
		cursor = end + 1
		var parsed map[string]any
		if err := json.Unmarshal([]byte(candidate), &parsed); err == nil {
			if _, ok := parsed["content"].(string); ok || stringValue(parsed["name"]) != "" || stringValue(parsed["input"]) != "" || parsed["stop"] == true {
				events = append(events, parsed)
			}
		}
	}
	state.buffer = ""
	return events
}

func newKiroSSEReader(source io.Reader, model string) io.Reader {
	reader, writer := io.Pipe()
	go func() {
		state := &kiroParserState{}
		completionID := randomID("chatcmpl")
		scanner := bufio.NewScanner(source)
		scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		sentRole := false
		toolCallCount := 0
		activeToolID := ""
		toolIndex := map[string]int{}
		writeChunk := func(delta map[string]any, finish any) {
			chunk := map[string]any{"id": completionID, "object": "chat.completion.chunk", "created": time.Now().Unix(), "model": model, "choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": finish}}}
			encoded, _ := json.Marshal(chunk)
			_, _ = writer.Write([]byte("data: " + string(encoded) + "\n\n"))
		}
		for scanner.Scan() {
			for _, event := range parseKiroJSONEvents(scanner.Text(), state) {
				if !sentRole {
					writeChunk(map[string]any{"role": "assistant", "content": ""}, nil)
					sentRole = true
				}
				if content := stringValue(event["content"]); content != "" {
					writeChunk(map[string]any{"content": content}, nil)
				}
				if name := stringValue(event["name"]); name != "" && stringValue(event["toolUseId"]) != "" {
					id := stringValue(event["toolUseId"])
					idx, ok := toolIndex[id]
					if !ok {
						idx = toolCallCount
						toolIndex[id] = idx
						toolCallCount++
					}
					activeToolID = id
					writeChunk(map[string]any{"tool_calls": []any{map[string]any{"index": idx, "id": id, "type": "function", "function": map[string]any{"name": name, "arguments": ""}}}}, nil)
				}
				if input := stringValue(event["input"]); input != "" && activeToolID != "" {
					writeChunk(map[string]any{"tool_calls": []any{map[string]any{"index": toolIndex[activeToolID], "function": map[string]any{"arguments": input}}}}, nil)
				}
				if event["stop"] == true {
					activeToolID = ""
				}
			}
		}
		for _, event := range parseKiroJSONEvents("", state) {
			if content := stringValue(event["content"]); content != "" {
				writeChunk(map[string]any{"content": content}, nil)
			}
		}
		finish := "stop"
		if toolCallCount > 0 {
			finish = "tool_calls"
		}
		writeChunk(map[string]any{}, finish)
		_, _ = writer.Write([]byte("data: [DONE]\n\n"))
		_ = writer.Close()
	}()
	return reader
}

func convertKiroEventsToCompletion(events []map[string]any, model string) map[string]any {
	content := ""
	activeToolID := ""
	type callState struct {
		index      int
		name, args string
	}
	toolByID := map[string]*callState{}
	for _, event := range events {
		if value := stringValue(event["content"]); value != "" {
			content += value
		}
		if name := stringValue(event["name"]); name != "" && stringValue(event["toolUseId"]) != "" {
			id := stringValue(event["toolUseId"])
			activeToolID = id
			if _, ok := toolByID[id]; !ok {
				toolByID[id] = &callState{index: len(toolByID), name: name}
			}
		}
		if input := stringValue(event["input"]); input != "" && activeToolID != "" {
			toolByID[activeToolID].args += input
		}
		if event["stop"] == true {
			activeToolID = ""
		}
	}
	toolCalls := make([]any, len(toolByID))
	for id, call := range toolByID {
		toolCalls[call.index] = map[string]any{"id": id, "type": "function", "function": map[string]any{"name": call.name, "arguments": defaultEmpty(call.args, "{}")}}
	}
	message := map[string]any{"role": "assistant", "content": nil}
	if content != "" {
		message["content"] = content
	}
	if len(toolCalls) > 0 {
		message["tool_calls"] = toolCalls
	}
	finish := "stop"
	if len(toolCalls) > 0 {
		finish = "tool_calls"
	}
	return map[string]any{"id": randomID("chatcmpl"), "object": "chat.completion", "created": time.Now().Unix(), "model": model, "choices": []any{map[string]any{"index": 0, "message": message, "finish_reason": finish}}, "usage": map[string]any{"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}}
}

func jsonResponse(status int, payload any) *http.Response {
	encoded, _ := json.Marshal(payload)
	return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(bytes.NewReader(encoded))}
}

func sseResponse(reader io.Reader, closer io.Closer) *http.Response {
	return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"text/event-stream"}, "Cache-Control": []string{"no-cache"}, "Connection": []string{"keep-alive"}}, Body: &qwenThinkTagReadCloser{reader: io.NopCloser(reader), closer: closer}}
}

func lastModelSegment(model string) string {
	if strings.Contains(model, "/") {
		parts := strings.Split(model, "/")
		return parts[len(parts)-1]
	}
	return model
}

func defaultEmpty(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

func stringValue(value any) string {
	str, _ := value.(string)
	return str
}

func defaultStringValue(value any, fallback string) string {
	if str := stringValue(value); str != "" {
		return str
	}
	return fallback
}

func randomID(prefix string) string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("%s_%d", prefix, time.Now().UnixNano())
	}
	return prefix + "_" + hex.EncodeToString(buf)
}
