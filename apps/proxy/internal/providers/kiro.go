package providers

import (
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
	kiroAPIBaseURL      = "https://q.%s.amazonaws.com/generateAssistantResponse"
	kiroRefreshEndpoint = "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken"
	kiroDefaultRegion   = "us-east-1"
	kiroThinkingStart   = "<thinking>"
	kiroThinkingEnd     = "</thinking>"
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
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, kiroAPIURLForAccount(account), bytes.NewReader(encoded))
	if err != nil {
		return nil, err
	}
	invocationID := randomID("kiro")
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(credentials))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "aws-sdk-js/3.738.0 ua/2.1 lang/go api/codewhisperer#3.738.0 m/E KiroIDE")
	req.Header.Set("x-amz-user-agent", "aws-sdk-js/3.738.0 KiroIDE")
	req.Header.Set("x-amzn-codewhisperer-optout", "true")
	req.Header.Set("x-amzn-kiro-agent-mode", "vibe")
	req.Header.Set("amz-sdk-invocation-id", invocationID)
	req.Header.Set("amz-sdk-request", "attempt=1; max=1")
	req.Header.Set("Connection", "close")

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
	rawMessages, _ := body["messages"].([]any)
	systemPrompt, messages := splitKiroSystemMessages(rawMessages)
	if instructions := strings.TrimSpace(stringValue(body["instructions"])); instructions != "" {
		systemPrompt = joinNonEmpty("\n\n", instructions, systemPrompt)
	}
	if kiroThinkingRequested(body) && !kiroUsesAdaptiveThinking(modelID) {
		prefix := fmt.Sprintf("<thinking_mode>enabled</thinking_mode><max_thinking_length>%d</max_thinking_length>", kiroThinkingBudget(body))
		if !strings.Contains(systemPrompt, "<thinking_mode>") {
			systemPrompt = joinNonEmpty("\n", prefix, systemPrompt)
		}
	}
	messages = normalizeKiroToolMessages(mergeAdjacentKiroMessages(messages))

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
		role := stringValue(last["role"])
		if role == "assistant" {
			if item := convertKiroMessageToHistoryItem(last, modelID); item != nil {
				history = append(history, item)
			}
			currentContent = "[system: conversation continues]"
		} else {
			var toolResults []any
			currentContent, toolResults = kiroUserContentAndToolResults(last["content"])
			if currentContent == "" {
				if len(toolResults) > 0 {
					currentContent = "Tool results provided."
				} else {
					currentContent = "Continue"
				}
			}
			if len(toolResults) > 0 {
				currentContext["toolResults"] = toolResults
			}
		}
	}
	if len(tools) > 0 {
		currentContext["tools"] = tools
	}

	userInput := map[string]any{"content": currentContent, "modelId": modelID, "origin": "AI_EDITOR"}
	if len(currentContext) > 0 {
		userInput["userInputMessageContext"] = currentContext
	}
	if kiroUserInputHasToolResults(userInput) && stringValue(userInput["content"]) == "Continue" {
		userInput["content"] = "Tool results provided."
	}
	history = reconcileKiroCurrentToolResults(history, rawMessages, userInput, modelID)
	if len(history) > 0 {
		if last, ok := history[len(history)-1].(map[string]any); ok {
			if _, ok := last["assistantResponseMessage"]; !ok {
				history = append(history, map[string]any{"assistantResponseMessage": map[string]any{"content": "[system: conversation continues]"}})
			}
		}
	}
	if systemPrompt != "" {
		if !injectKiroSystemPrompt(history, systemPrompt) {
			if !kiroUserInputHasToolResults(userInput) {
				userInput["content"] = joinNonEmpty("\n\n", systemPrompt, stringValue(userInput["content"]))
			}
		}
	}
	history = sanitizeKiroToolPairing(history, userInput)

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
	if p.registry.IsSupportedByProvider(raw, "kiro") {
		return p.registry.UpstreamModelName(raw, "kiro")
	}
	if strings.HasSuffix(raw, "-thinking") {
		base := strings.TrimSuffix(raw, "-thinking")
		if p.registry.IsSupportedByProvider(base, "kiro") {
			return p.registry.UpstreamModelName(base, "kiro")
		}
	}
	return p.registry.UpstreamModelName(raw, "kiro")
}

func convertKiroTools(raw any) []any {
	tools, _ := raw.([]any)
	result := []any{}
	for _, item := range tools {
		tool, _ := item.(map[string]any)
		fn, _ := tool["function"].(map[string]any)
		name := strings.TrimSpace(stringValue(fn["name"]))
		if name == "" {
			name = strings.TrimSpace(stringValue(tool["name"]))
			fn = tool
		}
		if name == "" {
			continue
		}
		params, ok := defaultAny(fn["parameters"], fn["input_schema"]).(map[string]any)
		if !ok {
			params = map[string]any{"type": "object", "properties": map[string]any{}}
		}
		result = append(result, map[string]any{"toolSpecification": map[string]any{"name": name, "description": kiroTruncate(defaultStringValue(fn["description"], ""), 9216), "inputSchema": map[string]any{"json": params}}})
	}
	return result
}

func convertKiroMessageToHistoryItem(raw any, modelID string) map[string]any {
	message, _ := raw.(map[string]any)
	role := stringValue(message["role"])
	if role == "assistant" {
		content, toolUses := kiroAssistantContentAndToolUses(message)
		if content == "" && len(toolUses) == 0 {
			return nil
		}
		assistant := map[string]any{"content": content}
		if len(toolUses) > 0 {
			assistant["toolUses"] = toolUses
		}
		return map[string]any{"assistantResponseMessage": assistant}
	}

	if role == "tool" {
		text := contentToText(message["content"])
		toolResults := kiroToolResultsFromContent(message["content"])
		if len(toolResults) == 0 {
			toolResults = []any{kiroToolResult(defaultStringValue(message["tool_call_id"], randomID("toolu")), text)}
		}
		return map[string]any{"userInputMessage": map[string]any{"content": "Tool results provided.", "modelId": modelID, "origin": "AI_EDITOR", "userInputMessageContext": map[string]any{"toolResults": dedupeKiroToolResults(toolResults)}}}
	}
	if role == "user" {
		text, toolResults := kiroUserContentAndToolResults(message["content"])
		if text == "" {
			if len(toolResults) > 0 {
				text = "Tool results provided."
			} else {
				text = "Continue"
			}
		}
		userInput := map[string]any{"content": text, "modelId": modelID, "origin": "AI_EDITOR"}
		if len(toolResults) > 0 {
			userInput["userInputMessageContext"] = map[string]any{"toolResults": toolResults}
		}
		return map[string]any{"userInputMessage": userInput}
	}
	return nil
}

func contentToText(content any) string {
	if text, ok := content.(string); ok {
		return text
	}
	if item, ok := content.(map[string]any); ok {
		for _, key := range []string{"text", "input_text", "output_text"} {
			if value := stringValue(item[key]); value != "" {
				return value
			}
		}
		if item["content"] != nil {
			return contentToText(item["content"])
		}
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
		if part["type"] == "tool_result" && part["content"] != nil {
			chunks = append(chunks, contentToText(part["content"]))
		}
	}
	return strings.Join(chunks, "")
}

func kiroUserContentAndToolResults(content any) (string, []any) {
	if _, ok := content.(string); ok {
		return contentToText(content), nil
	}
	if _, ok := content.(map[string]any); ok {
		return contentToText(content), nil
	}
	parts, _ := content.([]any)
	if len(parts) == 0 {
		return "", nil
	}
	textParts := []any{}
	toolResults := []any{}
	for _, raw := range parts {
		part, _ := raw.(map[string]any)
		if stringValue(part["type"]) == "tool_result" {
			id := defaultStringValue(part["tool_use_id"], stringValue(part["tool_call_id"]))
			if id != "" {
				toolResults = append(toolResults, kiroToolResult(id, contentToText(part["content"])))
			}
			continue
		}
		textParts = append(textParts, raw)
	}
	return contentToText(textParts), dedupeKiroToolResults(toolResults)
}

type kiroParserState struct{ buffer string }

func parseKiroJSONEvents(source string, state *kiroParserState) []map[string]any {
	state.buffer += source
	events := []map[string]any{}
	cursor := 0
	for cursor < len(state.buffer) {
		start := nextKiroJSONStart(state.buffer, cursor)
		if start == -1 {
			state.buffer = keepKiroParserTail(state.buffer[cursor:])
			return events
		}
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
			if isKiroResponseEvent(parsed) {
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
		splitter := &kiroThinkingSplitter{}
		completionID := randomID("chatcmpl")
		sentRole := false
		toolCallCount := 0
		activeToolID := ""
		toolIndex := map[string]int{}
		totalContent := ""
		outputText := ""
		contextUsagePercentage := 0.0
		writeChunk := func(delta map[string]any, finish any, usage map[string]any) {
			chunk := map[string]any{"id": completionID, "object": "chat.completion.chunk", "created": time.Now().Unix(), "model": model, "choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": finish}}}
			if usage != nil {
				chunk["usage"] = usage
			}
			encoded, _ := json.Marshal(chunk)
			_, _ = writer.Write([]byte("data: " + string(encoded) + "\n\n"))
		}
		ensureRole := func() {
			if !sentRole {
				writeChunk(map[string]any{"role": "assistant", "content": ""}, nil, nil)
				sentRole = true
			}
		}
		emitContent := func(contentDelta, reasoningDelta string) {
			if reasoningDelta != "" {
				ensureRole()
				outputText += reasoningDelta
				writeChunk(map[string]any{"reasoning_content": reasoningDelta}, nil, nil)
			}
			if contentDelta != "" {
				ensureRole()
				outputText += contentDelta
				writeChunk(map[string]any{"content": contentDelta}, nil, nil)
			}
		}
		processEvent := func(event map[string]any) {
			if value, ok := event["contextUsagePercentage"]; ok {
				contextUsagePercentage = kiroNumberAsFloat(value)
				return
			}
			if content, ok := event["content"].(string); ok && event["followupPrompt"] == nil {
				totalContent += content
				emitContent(splitter.Process(content, false))
			}
			if name := stringValue(event["name"]); name != "" && stringValue(event["toolUseId"]) != "" {
				ensureRole()
				id := stringValue(event["toolUseId"])
				idx, ok := toolIndex[id]
				if !ok {
					idx = toolCallCount
					toolIndex[id] = idx
					toolCallCount++
				}
				activeToolID = id
				writeChunk(map[string]any{"tool_calls": []any{map[string]any{"index": idx, "id": id, "type": "function", "function": map[string]any{"name": name, "arguments": ""}}}}, nil, nil)
				if input := stringValue(event["input"]); input != "" {
					writeChunk(map[string]any{"tool_calls": []any{map[string]any{"index": idx, "function": map[string]any{"arguments": input}}}}, nil, nil)
				}
			}
			if input := stringValue(event["input"]); input != "" && stringValue(event["name"]) == "" && activeToolID != "" {
				if idx, ok := toolIndex[activeToolID]; ok {
					ensureRole()
					writeChunk(map[string]any{"tool_calls": []any{map[string]any{"index": idx, "function": map[string]any{"arguments": input}}}}, nil, nil)
				}
			}
			if event["stop"] == true {
				activeToolID = ""
			}
		}

		buf := make([]byte, 32*1024)
		for {
			n, err := source.Read(buf)
			if n > 0 {
				for _, event := range parseKiroJSONEvents(string(buf[:n]), state) {
					processEvent(event)
				}
			}
			if err != nil {
				break
			}
		}
		for _, event := range parseKiroJSONEvents("", state) {
			processEvent(event)
		}
		emitContent(splitter.Flush())
		for _, call := range parseKiroBracketToolCalls(totalContent) {
			idx := toolCallCount
			toolCallCount++
			writeChunk(map[string]any{"tool_calls": []any{map[string]any{"index": idx, "id": call.ID, "type": "function", "function": map[string]any{"name": call.Name, "arguments": ""}}}}, nil, nil)
			writeChunk(map[string]any{"tool_calls": []any{map[string]any{"index": idx, "function": map[string]any{"arguments": call.Arguments}}}}, nil, nil)
		}
		finish := "stop"
		if toolCallCount > 0 {
			finish = "tool_calls"
		}
		writeChunk(map[string]any{}, finish, kiroUsageFromContext(model, contextUsagePercentage, outputText))
		_, _ = writer.Write([]byte("data: [DONE]\n\n"))
		_ = writer.Close()
	}()
	return reader
}

func convertKiroEventsToCompletion(events []map[string]any, model string) map[string]any {
	content := ""
	reasoning := ""
	outputText := ""
	activeToolID := ""
	contextUsagePercentage := 0.0
	splitter := &kiroThinkingSplitter{}
	type callState struct {
		index      int
		name, args string
	}
	toolByID := map[string]*callState{}
	for _, event := range events {
		if value, ok := event["contextUsagePercentage"]; ok {
			contextUsagePercentage = kiroNumberAsFloat(value)
		}
		if value, ok := event["content"].(string); ok && event["followupPrompt"] == nil {
			textDelta, reasoningDelta := splitter.Process(value, false)
			content += textDelta
			reasoning += reasoningDelta
			outputText += textDelta + reasoningDelta
		}
		if name := stringValue(event["name"]); name != "" && stringValue(event["toolUseId"]) != "" {
			id := stringValue(event["toolUseId"])
			activeToolID = id
			if _, ok := toolByID[id]; !ok {
				toolByID[id] = &callState{index: len(toolByID), name: name}
			}
			if input := stringValue(event["input"]); input != "" {
				toolByID[id].args += input
			}
		}
		if input := stringValue(event["input"]); input != "" && stringValue(event["name"]) == "" && activeToolID != "" {
			toolByID[activeToolID].args += input
		}
		if event["stop"] == true {
			activeToolID = ""
		}
	}
	textDelta, reasoningDelta := splitter.Flush()
	content += textDelta
	reasoning += reasoningDelta
	outputText += textDelta + reasoningDelta

	toolCalls := make([]any, len(toolByID))
	for id, call := range toolByID {
		toolCalls[call.index] = map[string]any{"id": id, "type": "function", "function": map[string]any{"name": call.name, "arguments": defaultEmpty(call.args, "{}")}}
	}
	if bracketCalls := parseKiroBracketToolCalls(content); len(bracketCalls) > 0 {
		content = cleanKiroBracketToolCalls(content, bracketCalls)
		for _, call := range bracketCalls {
			toolCalls = append(toolCalls, map[string]any{"id": call.ID, "type": "function", "function": map[string]any{"name": call.Name, "arguments": call.Arguments}})
		}
	}

	message := map[string]any{"role": "assistant", "content": nil}
	if content != "" {
		message["content"] = content
	}
	if reasoning != "" {
		message["reasoning_content"] = reasoning
	}
	if len(toolCalls) > 0 {
		message["tool_calls"] = toolCalls
	}
	finish := "stop"
	if len(toolCalls) > 0 {
		finish = "tool_calls"
	}
	return map[string]any{"id": randomID("chatcmpl"), "object": "chat.completion", "created": time.Now().Unix(), "model": model, "choices": []any{map[string]any{"index": 0, "message": message, "finish_reason": finish}}, "usage": kiroUsageFromContext(model, contextUsagePercentage, outputText)}
}

func splitKiroSystemMessages(rawMessages []any) (string, []any) {
	systemParts := []string{}
	messages := []any{}
	for _, raw := range rawMessages {
		msg, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		role := stringValue(msg["role"])
		if role == "system" || role == "developer" {
			if text := strings.TrimSpace(contentToText(msg["content"])); text != "" {
				systemParts = append(systemParts, text)
			}
			continue
		}
		messages = append(messages, raw)
	}
	return strings.Join(systemParts, "\n\n"), messages
}

func normalizeKiroToolMessages(messages []any) []any {
	normalized := []any{}
	pendingToolResults := []any{}
	flushPending := func() {
		if len(pendingToolResults) == 0 {
			return
		}
		normalized = append(normalized, map[string]any{"role": "user", "content": pendingToolResults})
		pendingToolResults = nil
	}

	for _, raw := range messages {
		msg, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		role := stringValue(msg["role"])
		if role == "tool" {
			pendingToolResults = append(pendingToolResults, map[string]any{"type": "tool_result", "tool_call_id": defaultStringValue(msg["tool_call_id"], randomID("toolu")), "content": msg["content"]})
			continue
		}
		if role == "assistant" {
			flushPending()
			normalized = append(normalized, raw)
			continue
		}
		if role == "user" {
			if len(pendingToolResults) > 0 {
				copyMsg := cloneAnyMap(msg)
				copyMsg["content"] = mergeKiroContent(pendingToolResults, msg["content"])
				normalized = append(normalized, copyMsg)
				pendingToolResults = nil
				continue
			}
		}
		normalized = append(normalized, raw)
	}
	flushPending()
	return normalized
}

func mergeAdjacentKiroMessages(messages []any) []any {
	merged := []any{}
	for _, raw := range messages {
		msg, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		role := stringValue(msg["role"])
		if len(merged) > 0 && role != "tool" {
			last, _ := merged[len(merged)-1].(map[string]any)
			if stringValue(last["role"]) == role {
				last["content"] = mergeKiroContent(last["content"], msg["content"])
				if calls, ok := msg["tool_calls"].([]any); ok && len(calls) > 0 {
					existing, _ := last["tool_calls"].([]any)
					last["tool_calls"] = append(existing, calls...)
				}
				continue
			}
		}
		merged = append(merged, cloneAnyMap(msg))
	}
	return merged
}

func mergeKiroContent(a, b any) any {
	aParts, aIsParts := a.([]any)
	bParts, bIsParts := b.([]any)
	switch {
	case aIsParts && bIsParts:
		return append(append([]any{}, aParts...), bParts...)
	case aIsParts:
		if text := stringValue(b); text != "" {
			return append(append([]any{}, aParts...), map[string]any{"type": "text", "text": text})
		}
		return a
	case bIsParts:
		if text := stringValue(a); text != "" {
			return append([]any{map[string]any{"type": "text", "text": text}}, bParts...)
		}
		return b
	default:
		return joinNonEmpty("\n", contentToText(a), contentToText(b))
	}
}

func kiroAssistantContentAndToolUses(message map[string]any) (string, []any) {
	content := ""
	thinking := ""
	toolUses := []any{}
	if parts, ok := message["content"].([]any); ok {
		for _, rawPart := range parts {
			part, _ := rawPart.(map[string]any)
			switch stringValue(part["type"]) {
			case "text", "output_text":
				content += contentToText(part)
			case "thinking":
				thinking += defaultStringValue(part["thinking"], stringValue(part["text"]))
			case "tool_use":
				id := stringValue(part["id"])
				name := stringValue(part["name"])
				if id != "" && name != "" {
					toolUses = append(toolUses, map[string]any{"toolUseId": id, "name": name, "input": defaultAny(part["input"], map[string]any{})})
				}
			}
		}
	} else {
		content = contentToText(message["content"])
	}
	if calls, ok := message["tool_calls"].([]any); ok && len(calls) > 0 {
		for _, rawCall := range calls {
			if toolUse := kiroToolUseFromOpenAICall(rawCall); toolUse != nil {
				toolUses = append(toolUses, toolUse)
			}
		}
	}
	if thinking != "" {
		wrapped := kiroThinkingStart + thinking + kiroThinkingEnd
		if content != "" {
			content = wrapped + "\n\n" + content
		} else {
			content = wrapped
		}
	}
	return content, toolUses
}

func kiroToolUseFromOpenAICall(rawCall any) map[string]any {
	call, _ := rawCall.(map[string]any)
	fn, _ := call["function"].(map[string]any)
	id := stringValue(call["id"])
	name := stringValue(fn["name"])
	if id == "" || name == "" {
		return nil
	}
	var input any = map[string]any{}
	if args := stringValue(fn["arguments"]); args != "" {
		if err := json.Unmarshal([]byte(args), &input); err != nil {
			input = map[string]any{}
		}
	}
	return map[string]any{"toolUseId": id, "name": name, "input": input}
}

func kiroToolResultsFromContent(content any) []any {
	parts, ok := content.([]any)
	if !ok {
		return nil
	}
	results := []any{}
	for _, raw := range parts {
		part, _ := raw.(map[string]any)
		if stringValue(part["type"]) != "tool_result" {
			continue
		}
		id := defaultStringValue(part["tool_use_id"], stringValue(part["tool_call_id"]))
		if id == "" {
			continue
		}
		results = append(results, kiroToolResult(id, contentToText(part["content"])))
	}
	return results
}

func reconcileKiroCurrentToolResults(history []any, rawMessages []any, userInput map[string]any, modelID string) []any {
	ctx, _ := userInput["userInputMessageContext"].(map[string]any)
	rawResults, _ := ctx["toolResults"].([]any)
	if len(rawResults) == 0 {
		return history
	}
	historyIDs := kiroHistoryToolUseIDs(history)
	finalResults := []any{}
	orphanedToolUses := []any{}
	for _, raw := range rawResults {
		result, _ := raw.(map[string]any)
		id := stringValue(result["toolUseId"])
		if id == "" || historyIDs[id] {
			finalResults = append(finalResults, raw)
			continue
		}
		if original := findOriginalKiroToolCall(rawMessages, id); original != nil {
			orphanedToolUses = append(orphanedToolUses, original)
			finalResults = append(finalResults, raw)
			historyIDs[id] = true
			continue
		}
		userInput["content"] = joinNonEmpty("\n\n", stringValue(userInput["content"]), fmt.Sprintf("[Output for tool call %s]:\n%s", id, kiroToolResultText(result)))
	}
	if len(orphanedToolUses) > 0 {
		if len(history) == 0 || kiroHistoryItemHasAssistant(history[len(history)-1]) {
			history = append(history, map[string]any{"userInputMessage": map[string]any{"content": "Running tools...", "modelId": modelID, "origin": "AI_EDITOR"}})
		}
		history = append(history, map[string]any{"assistantResponseMessage": map[string]any{"content": "I will execute the following tools.", "toolUses": orphanedToolUses}})
	}
	setKiroCurrentToolResults(userInput, finalResults)
	return history
}

func setKiroCurrentToolResults(userInput map[string]any, results []any) {
	ctx, _ := userInput["userInputMessageContext"].(map[string]any)
	if ctx == nil {
		ctx = map[string]any{}
	}
	if len(results) > 0 {
		ctx["toolResults"] = dedupeKiroToolResults(results)
	} else {
		delete(ctx, "toolResults")
	}
	if len(ctx) > 0 {
		userInput["userInputMessageContext"] = ctx
	} else {
		delete(userInput, "userInputMessageContext")
	}
}

func findOriginalKiroToolCall(messages []any, toolUseID string) map[string]any {
	for _, raw := range messages {
		msg, _ := raw.(map[string]any)
		if stringValue(msg["role"]) != "assistant" {
			continue
		}
		if calls, ok := msg["tool_calls"].([]any); ok {
			for _, rawCall := range calls {
				toolUse := kiroToolUseFromOpenAICall(rawCall)
				if toolUse != nil && toolUse["toolUseId"] == toolUseID {
					return toolUse
				}
			}
		}
		if parts, ok := msg["content"].([]any); ok {
			for _, rawPart := range parts {
				part, _ := rawPart.(map[string]any)
				if stringValue(part["type"]) == "tool_use" && stringValue(part["id"]) == toolUseID {
					return map[string]any{"toolUseId": toolUseID, "name": stringValue(part["name"]), "input": defaultAny(part["input"], map[string]any{})}
				}
			}
		}
	}
	return nil
}

func kiroHistoryToolUseIDs(history []any) map[string]bool {
	ids := map[string]bool{}
	for _, raw := range history {
		item, _ := raw.(map[string]any)
		assistant, _ := item["assistantResponseMessage"].(map[string]any)
		toolUses, _ := assistant["toolUses"].([]any)
		for _, rawUse := range toolUses {
			use, _ := rawUse.(map[string]any)
			if id := stringValue(use["toolUseId"]); id != "" {
				ids[id] = true
			}
		}
	}
	return ids
}

func kiroHistoryItemHasAssistant(raw any) bool {
	item, _ := raw.(map[string]any)
	_, ok := item["assistantResponseMessage"]
	return ok
}

func injectKiroSystemPrompt(history []any, systemPrompt string) bool {
	for _, raw := range history {
		item, _ := raw.(map[string]any)
		user, _ := item["userInputMessage"].(map[string]any)
		if user == nil {
			continue
		}
		if kiroUserInputHasToolResults(user) {
			continue
		}
		user["content"] = joinNonEmpty("\n\n", systemPrompt, stringValue(user["content"]))
		return true
	}
	return false
}

func kiroUserInputHasToolResults(userInput map[string]any) bool {
	ctx, _ := userInput["userInputMessageContext"].(map[string]any)
	results, _ := ctx["toolResults"].([]any)
	return len(results) > 0
}

func sanitizeKiroToolPairing(history []any, currentUser map[string]any) []any {
	sanitized := make([]any, 0, len(history))
	var pendingAssistant map[string]any
	var pendingToolIDs map[string]bool
	for _, raw := range history {
		item, _ := raw.(map[string]any)
		assistant, _ := item["assistantResponseMessage"].(map[string]any)
		if assistant != nil {
			filterKiroAssistantToolUses(pendingAssistant, nil)
			pendingAssistant = assistant
			pendingToolIDs = kiroAssistantToolUseIDs(assistant)
			sanitized = append(sanitized, raw)
			continue
		}

		if user, _ := item["userInputMessage"].(map[string]any); user != nil {
			resultIDs := sanitizeKiroUserToolResults(user, pendingToolIDs)
			filterKiroAssistantToolUses(pendingAssistant, resultIDs)
			pendingAssistant = nil
			pendingToolIDs = nil
		}
		sanitized = append(sanitized, raw)
	}
	currentResultIDs := sanitizeKiroUserToolResults(currentUser, pendingToolIDs)
	filterKiroAssistantToolUses(pendingAssistant, currentResultIDs)
	return sanitized
}

func kiroAssistantToolUseIDs(assistant map[string]any) map[string]bool {
	uses, _ := assistant["toolUses"].([]any)
	if len(uses) == 0 {
		return nil
	}
	ids := map[string]bool{}
	for _, rawUse := range uses {
		use, _ := rawUse.(map[string]any)
		if id := stringValue(use["toolUseId"]); id != "" {
			ids[id] = true
		}
	}
	return ids
}

func sanitizeKiroUserToolResults(user map[string]any, allowed map[string]bool) map[string]bool {
	ctx, _ := user["userInputMessageContext"].(map[string]any)
	results, _ := ctx["toolResults"].([]any)
	if len(results) == 0 {
		return nil
	}
	if len(allowed) == 0 {
		return nil
	}
	kept := []any{}
	keptIDs := map[string]bool{}
	for _, rawResult := range results {
		result, _ := rawResult.(map[string]any)
		id := stringValue(result["toolUseId"])
		if id != "" && allowed[id] {
			kept = append(kept, rawResult)
			keptIDs[id] = true
			continue
		}
		user["content"] = joinNonEmpty("\n\n", stringValue(user["content"]), fmt.Sprintf("[Output for tool call %s]:\n%s", defaultEmpty(id, "unknown"), kiroToolResultText(result)))
	}
	setKiroCurrentToolResults(user, kept)
	if len(keptIDs) == 0 {
		return nil
	}
	return keptIDs
}

func filterKiroAssistantToolUses(assistant map[string]any, resultIDs map[string]bool) {
	if assistant == nil {
		return
	}
	uses, _ := assistant["toolUses"].([]any)
	if len(uses) == 0 {
		return
	}
	kept := make([]any, 0, len(uses))
	for _, rawUse := range uses {
		use, _ := rawUse.(map[string]any)
		if resultIDs[stringValue(use["toolUseId"])] {
			kept = append(kept, rawUse)
		}
	}
	if len(kept) > 0 {
		assistant["toolUses"] = kept
		return
	}
	delete(assistant, "toolUses")
}

func kiroToolResult(id, text string) map[string]any {
	return map[string]any{"toolUseId": id, "status": "success", "content": []any{map[string]any{"text": text}}}
}

func dedupeKiroToolResults(results []any) []any {
	seen := map[string]bool{}
	out := []any{}
	for _, raw := range results {
		result, _ := raw.(map[string]any)
		id := stringValue(result["toolUseId"])
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, raw)
	}
	return out
}

func kiroToolResultText(result map[string]any) string {
	content, _ := result["content"].([]any)
	return contentToText(content)
}

func kiroUsesAdaptiveThinking(modelID string) bool {
	modelID = strings.ToLower(lastModelSegment(strings.TrimSpace(modelID)))
	return modelID == "claude-opus-4.7" || modelID == "claude-opus-4-7"
}

func kiroThinkingRequested(body map[string]any) bool {
	if kiroIncludeThoughtsFalse(body) || kiroReasoningEffort(body) == "none" {
		return false
	}
	if kiroExplicitThinkingBudget(body) > 0 {
		return true
	}
	if effort := kiroReasoningEffort(body); effort != "" {
		return defaultThinkingBudget(effort) > 0
	}
	if include, ok := body["include_thoughts"].(bool); ok && include {
		return true
	}
	if enabled, ok := body["_includeReasoning"].(bool); ok && enabled {
		return true
	}
	if strings.HasSuffix(lastModelSegment(stringValue(body["model"])), "-thinking") {
		return true
	}
	for _, key := range []string{"thinking_budget", "include_thoughts", "reasoning", "reasoning_effort"} {
		if body[key] != nil {
			return true
		}
	}
	return false
}

func kiroThinkingBudget(body map[string]any) int {
	if budget := kiroExplicitThinkingBudget(body); budget > 0 {
		return budget
	}
	if budget := defaultThinkingBudget(kiroReasoningEffort(body)); budget > 0 {
		return budget
	}
	return 20000
}

func kiroExplicitThinkingBudget(body map[string]any) int {
	if budget := numberFromAny(body["thinking_budget"]); budget > 0 {
		return budget
	}
	if reasoning, ok := body["reasoning"].(map[string]any); ok {
		for _, key := range []string{"max_tokens", "budget_tokens", "thinking_budget"} {
			if budget := numberFromAny(reasoning[key]); budget > 0 {
				return budget
			}
		}
	}
	return 0
}

func kiroReasoningEffort(body map[string]any) string {
	if reasoning, ok := body["reasoning"].(map[string]any); ok {
		if effort := stringValue(reasoning["effort"]); effort != "" {
			return effort
		}
	}
	return stringValue(body["reasoning_effort"])
}

func kiroIncludeThoughtsFalse(body map[string]any) bool {
	if include, ok := body["include_thoughts"].(bool); ok && !include {
		return true
	}
	if reasoning, ok := body["reasoning"].(map[string]any); ok {
		if include, ok := defaultAny(reasoning["include_thoughts"], reasoning["includeThoughts"]).(bool); ok && !include {
			return true
		}
	}
	return false
}

func nextKiroJSONStart(buffer string, offset int) int {
	patterns := []string{`{"content":`, `{"name":`, `{"followupPrompt":`, `{"input":`, `{"stop":`, `{"contextUsagePercentage":`}
	best := -1
	for _, pattern := range patterns {
		if idx := strings.Index(buffer[offset:], pattern); idx >= 0 {
			idx += offset
			if best == -1 || idx < best {
				best = idx
			}
		}
	}
	return best
}

func keepKiroParserTail(value string) string {
	if len(value) <= 64 {
		return value
	}
	return value[len(value)-64:]
}

func isKiroResponseEvent(parsed map[string]any) bool {
	if _, ok := parsed["content"].(string); ok && parsed["followupPrompt"] == nil {
		return true
	}
	if stringValue(parsed["name"]) != "" && stringValue(parsed["toolUseId"]) != "" {
		return true
	}
	if _, ok := parsed["input"].(string); ok {
		return true
	}
	if _, ok := parsed["stop"]; ok && parsed["contextUsagePercentage"] == nil {
		return true
	}
	if _, ok := parsed["contextUsagePercentage"]; ok {
		return true
	}
	return false
}

type kiroThinkingSplitter struct {
	buffer            string
	inThinking        bool
	thinkingExtracted bool
}

func (s *kiroThinkingSplitter) Process(delta string, final bool) (string, string) {
	s.buffer += delta
	content := ""
	reasoning := ""
	for s.buffer != "" {
		if !s.inThinking && !s.thinkingExtracted {
			start := findKiroRealTag(s.buffer, kiroThinkingStart)
			if start >= 0 {
				content += s.buffer[:start]
				s.buffer = s.buffer[start+len(kiroThinkingStart):]
				s.inThinking = true
				continue
			}
			if final {
				content += s.buffer
				s.buffer = ""
				break
			}
			safeLen := max(0, len(s.buffer)-len(kiroThinkingStart))
			if safeLen > 0 {
				content += s.buffer[:safeLen]
				s.buffer = s.buffer[safeLen:]
			}
			break
		}
		if s.inThinking {
			end := findKiroRealTag(s.buffer, kiroThinkingEnd)
			if end >= 0 {
				reasoning += s.buffer[:end]
				s.buffer = s.buffer[end+len(kiroThinkingEnd):]
				s.inThinking = false
				s.thinkingExtracted = true
				s.buffer = strings.TrimPrefix(s.buffer, "\n\n")
				continue
			}
			if final {
				reasoning += s.buffer
				s.buffer = ""
				break
			}
			safeLen := max(0, len(s.buffer)-len(kiroThinkingEnd))
			if safeLen > 0 {
				reasoning += s.buffer[:safeLen]
				s.buffer = s.buffer[safeLen:]
			}
			break
		}
		content += s.buffer
		s.buffer = ""
	}
	return content, reasoning
}

func (s *kiroThinkingSplitter) Flush() (string, string) {
	return s.Process("", true)
}

func findKiroRealTag(buffer, tag string) int {
	pos := 0
	inCodeBlock := false
	for pos < len(buffer) {
		tagRel := strings.Index(buffer[pos:], tag)
		if tagRel == -1 {
			return -1
		}
		tagPos := pos + tagRel
		if fenceRel := strings.Index(buffer[pos:], "```"); fenceRel != -1 && pos+fenceRel < tagPos {
			inCodeBlock = !inCodeBlock
			pos += fenceRel + len("```")
			continue
		}
		if !inCodeBlock {
			return tagPos
		}
		pos = tagPos + len(tag)
	}
	return -1
}

type kiroBracketToolCall struct {
	ID        string
	Name      string
	Arguments string
	Raw       string
}

func parseKiroBracketToolCalls(text string) []kiroBracketToolCall {
	calls := []kiroBracketToolCall{}
	search := 0
	for search < len(text) {
		startRel := strings.Index(text[search:], "[Called ")
		if startRel == -1 {
			break
		}
		start := search + startRel
		nameStart := start + len("[Called ")
		markerRel := strings.Index(text[nameStart:], " with args:")
		if markerRel == -1 {
			search = nameStart
			continue
		}
		marker := nameStart + markerRel
		name := strings.TrimSpace(text[nameStart:marker])
		argsStart := marker + len(" with args:")
		for argsStart < len(text) && (text[argsStart] == ' ' || text[argsStart] == '\n' || text[argsStart] == '\t') {
			argsStart++
		}
		if name == "" || argsStart >= len(text) || text[argsStart] != '{' {
			search = argsStart
			continue
		}
		argsEnd := findBalancedJSONEnd(text, argsStart)
		if argsEnd == -1 {
			break
		}
		closeIdx := argsEnd + 1
		for closeIdx < len(text) && (text[closeIdx] == ' ' || text[closeIdx] == '\n' || text[closeIdx] == '\t') {
			closeIdx++
		}
		if closeIdx >= len(text) || text[closeIdx] != ']' {
			search = argsEnd + 1
			continue
		}
		args := text[argsStart : argsEnd+1]
		if !json.Valid([]byte(args)) {
			search = closeIdx + 1
			continue
		}
		calls = append(calls, kiroBracketToolCall{ID: randomID("toolu"), Name: name, Arguments: args, Raw: text[start : closeIdx+1]})
		search = closeIdx + 1
	}
	return calls
}

func cleanKiroBracketToolCalls(text string, calls []kiroBracketToolCall) string {
	cleaned := text
	for _, call := range calls {
		cleaned = strings.ReplaceAll(cleaned, call.Raw, "")
	}
	return strings.TrimSpace(strings.Join(strings.Fields(cleaned), " "))
}

func findBalancedJSONEnd(text string, start int) int {
	depth := 0
	inString := false
	escaped := false
	for i := start; i < len(text); i++ {
		ch := text[i]
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
				return i
			}
		}
	}
	return -1
}

func kiroUsageFromContext(model string, contextUsagePercentage float64, outputText string) map[string]any {
	outputTokens := estimateKiroTokens(outputText)
	inputTokens := 0
	if contextUsagePercentage > 0 {
		totalTokens := int((float64(kiroContextWindowSize(model))*contextUsagePercentage)/100 + 0.5)
		inputTokens = max(0, totalTokens-outputTokens)
	}
	return map[string]any{"prompt_tokens": inputTokens, "completion_tokens": outputTokens, "total_tokens": inputTokens + outputTokens}
}

func kiroContextWindowSize(model string) int {
	if strings.Contains(model, "-1m") {
		return 1000000
	}
	return 200000
}

func estimateKiroTokens(text string) int {
	if text == "" {
		return 0
	}
	return (len(text) + 3) / 4
}

func kiroNumberAsFloat(value any) float64 {
	switch v := value.(type) {
	case float64:
		return v
	case float32:
		return float64(v)
	case int:
		return float64(v)
	case int64:
		return float64(v)
	case json.Number:
		f, _ := v.Float64()
		return f
	default:
		return 0
	}
}

func kiroAPIURLForAccount(account appdb.ProviderAccount) string {
	region := kiroDefaultRegion
	if account.AccountID != nil {
		if extracted := kiroRegionFromARN(*account.AccountID); extracted != "" {
			region = extracted
		}
	}
	return fmt.Sprintf(kiroAPIBaseURL, region)
}

func kiroRegionFromARN(arn string) string {
	parts := strings.Split(strings.TrimSpace(arn), ":")
	if len(parts) >= 4 && parts[0] == "arn" && parts[3] != "" {
		return parts[3]
	}
	return ""
}

func joinNonEmpty(sep string, values ...string) string {
	parts := []string{}
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			parts = append(parts, value)
		}
	}
	return strings.Join(parts, sep)
}

func kiroTruncate(value string, maxLen int) string {
	if maxLen <= 0 || len(value) <= maxLen {
		return value
	}
	return value[:maxLen]
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
