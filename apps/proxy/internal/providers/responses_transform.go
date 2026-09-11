package providers

import (
	"bufio"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

func messagesToResponsesInput(messages []any) []any {
	input := []any{}
	for _, raw := range messages {
		msg, _ := raw.(map[string]any)
		role := stringValue(msg["role"])
		content := normalizeResponsesContent(msg["content"], role)
		switch role {
		case "system", "developer":
			input = append(input, map[string]any{"type": "message", "role": "developer", "content": content})
		case "user":
			input = append(input, map[string]any{"type": "message", "role": "user", "content": content})
		case "assistant":
			if calls, ok := msg["tool_calls"].([]any); ok && len(calls) > 0 {
				if content != nil && contentToText(content) != "" {
					input = append(input, map[string]any{"type": "message", "role": "assistant", "content": content})
				}
				for _, rawCall := range calls {
					call, _ := rawCall.(map[string]any)
					fn, _ := call["function"].(map[string]any)
					name := stringValue(fn["name"])
					if name == "" {
						continue
					}
					id := toResponsesAPIID(stringValue(call["id"]))
					input = append(input, map[string]any{"type": "function_call", "id": id, "call_id": id, "name": name, "arguments": defaultStringValue(fn["arguments"], "{}")})
				}
			} else {
				input = append(input, map[string]any{"type": "message", "role": "assistant", "content": content})
			}
		case "tool":
			input = append(input, map[string]any{"type": "function_call_output", "call_id": toResponsesAPIID(stringValue(msg["tool_call_id"])), "output": contentToText(msg["content"])})
		default:
			input = append(input, map[string]any{"type": "message", "role": defaultEmpty(role, "user"), "content": content})
		}
	}
	return input
}

func normalizeResponsesInput(input []any) []any {
	out := make([]any, 0, len(input))
	for _, raw := range input {
		item, ok := raw.(map[string]any)
		if !ok {
			out = append(out, raw)
			continue
		}
		copyItem := cloneAnyMap(item)
		typ := stringValue(copyItem["type"])
		if typ == "" {
			typ = inferResponsesInputType(copyItem)
			if typ != "" {
				copyItem["type"] = typ
			}
		}
		if typ == "function_call" {
			id := toResponsesAPIID(defaultStringValue(copyItem["id"], stringValue(copyItem["call_id"])))
			copyItem["id"] = id
			copyItem["call_id"] = id
		}
		if typ == "function_call_output" {
			copyItem["call_id"] = toResponsesAPIID(stringValue(copyItem["call_id"]))
		}
		if typ == "message" {
			copyItem["content"] = normalizeResponsesContent(copyItem["content"], defaultStringValue(copyItem["role"], "user"))
		}
		out = append(out, copyItem)
	}
	return out
}

// inferResponsesInputType resolves the item type for clients that send the
// Responses API shorthand, most notably messages as `{role, content}` with no
// `type` field. Upstream providers reject items without an explicit type.
func inferResponsesInputType(item map[string]any) string {
	if _, ok := item["summary"]; ok {
		return "reasoning"
	}
	if _, ok := item["encrypted_content"]; ok {
		return "reasoning"
	}
	if item["call_id"] != nil && item["name"] != nil {
		return "function_call"
	}
	if item["call_id"] != nil && item["output"] != nil {
		return "function_call_output"
	}
	if item["role"] != nil {
		return "message"
	}
	return ""
}

func normalizeResponsesContent(content any, role string) any {
	parts, ok := content.([]any)
	if !ok {
		return content
	}
	targetTextType := "input_text"
	if role == "assistant" {
		targetTextType = "output_text"
	}
	out := make([]any, 0, len(parts))
	for _, raw := range parts {
		part, ok := raw.(map[string]any)
		if !ok {
			out = append(out, raw)
			continue
		}
		copyPart := cloneAnyMap(part)
		if copyPart["type"] == "text" {
			copyPart["type"] = targetTextType
		}
		if copyPart["type"] == "image_url" {
			copyPart["type"] = "input_image"
			if imageURL, ok := copyPart["image_url"].(map[string]any); ok {
				copyPart["image_url"] = stringValue(imageURL["url"])
				if imageURL["detail"] != nil {
					copyPart["detail"] = imageURL["detail"]
				}
			}
		}
		out = append(out, copyPart)
	}
	return out
}

func extractInstructions(messages []any) string {
	parts := []string{}
	for _, raw := range messages {
		msg, _ := raw.(map[string]any)
		role := stringValue(msg["role"])
		if role != "system" && role != "developer" {
			continue
		}
		text := strings.TrimSpace(contentToText(msg["content"]))
		if text != "" {
			parts = append(parts, text)
		}
	}
	return strings.Join(parts, "\n\n")
}

func convertToolsForResponses(raw any) []any {
	tools, _ := raw.([]any)
	out := []any{}
	for _, item := range tools {
		tool, _ := item.(map[string]any)
		fn, _ := tool["function"].(map[string]any)
		name := stringValue(fn["name"])
		if name == "" {
			name = stringValue(tool["name"])
			fn = tool
		}
		if name == "" {
			continue
		}
		params, ok := fn["parameters"].(map[string]any)
		if !ok {
			params = map[string]any{"type": "object", "properties": map[string]any{}}
		}
		converted := map[string]any{"type": "function", "name": name, "description": defaultStringValue(fn["description"], ""), "parameters": params}
		if strict, ok := fn["strict"].(bool); ok {
			converted["strict"] = strict
		}
		out = append(out, converted)
	}
	return out
}

func toResponsesAPIID(id string) string {
	if id == "" {
		return randomID("fc")
	}
	if strings.HasPrefix(id, "fc_") || strings.HasPrefix(id, "fc-") || strings.HasPrefix(id, "apc_") {
		return id
	}
	if strings.HasPrefix(id, "call_") {
		return "fc_" + strings.TrimPrefix(id, "call_")
	}
	return "fc_" + id
}

func toChatCallID(id string) string {
	if id == "" {
		return randomID("call")
	}
	if strings.HasPrefix(id, "call_") {
		return id
	}
	if strings.HasPrefix(id, "fc_") || strings.HasPrefix(id, "fc-") {
		return "call_" + id[3:]
	}
	return "call_" + id
}

func responsesSSEToChatSSEReader(source io.Reader, model string) io.Reader {
	reader, writer := io.Pipe()
	go func() {
		transformResponsesSSEToChat(source, writer, model)
		_ = writer.Close()
	}()
	return reader
}

type reasoningParts struct {
	parts map[string]string
	order []string
}

func newReasoningParts() *reasoningParts {
	return &reasoningParts{parts: map[string]string{}}
}

func (r *reasoningParts) append(key, text string) (string, bool) {
	if text == "" {
		return "", false
	}
	existing, seen := r.parts[key]
	missing := text
	if strings.HasPrefix(text, existing) {
		missing = strings.TrimPrefix(text, existing)
	}
	if missing == "" {
		return "", false
	}
	r.parts[key] = existing + missing
	if !seen {
		r.order = append(r.order, key)
	}
	return missing, !seen
}

func (r *reasoningParts) text() string {
	chunks := make([]string, 0, len(r.order))
	for _, key := range r.order {
		if value := r.parts[key]; value != "" {
			chunks = append(chunks, value)
		}
	}
	return strings.Join(chunks, "\n\n")
}

func (r *reasoningParts) addItem(item map[string]any, emit func(string, string)) {
	if summary, ok := item["summary"].([]any); ok && len(summary) > 0 {
		for index, raw := range summary {
			text := ""
			if str, ok := raw.(string); ok {
				text = str
			} else if part, ok := raw.(map[string]any); ok {
				text = stringValue(part["text"])
			}
			if text != "" {
				emit(reasoningKey("summary", index), text)
			}
		}
		return
	}
	if content, ok := item["content"].([]any); ok && len(content) > 0 {
		for index, raw := range content {
			part, _ := raw.(map[string]any)
			if text := stringValue(part["text"]); text != "" {
				emit(reasoningKey("text", index), text)
			}
		}
		return
	}
	if text := stringValue(item["text"]); text != "" {
		emit(reasoningKey("text", 0), text)
	}
}

func reasoningKey(family string, index any) string {
	return family + ":" + strconv.Itoa(numberFromAny(index))
}

func transformResponsesSSEToChat(source io.Reader, writer io.Writer, model string) {
	completionID := randomID("chatcmpl")
	scanner := bufio.NewScanner(source)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	sentRole := false
	toolIndex := 0
	reasoning := newReasoningParts()
	reasoningEmitted := false
	writeChunk := func(delta map[string]any, finish any, usage map[string]any) {
		chunk := map[string]any{"id": completionID, "object": "chat.completion.chunk", "created": time.Now().Unix(), "model": model, "choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": finish}}}
		if usage != nil {
			chunk["usage"] = usage
		}
		encoded, _ := json.Marshal(chunk)
		_, _ = writer.Write([]byte("data: " + string(encoded) + "\n\n"))
	}
	emitReasoning := func(key, text string) {
		missing, isNewPart := reasoning.append(key, text)
		if missing == "" {
			return
		}
		if isNewPart && reasoningEmitted {
			missing = "\n\n" + missing
		}
		reasoningEmitted = true
		if !sentRole {
			writeChunk(map[string]any{"role": "assistant", "content": ""}, nil, nil)
			sentRole = true
		}
		writeChunk(map[string]any{"reasoning_content": missing}, nil, nil)
	}
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "" || data == "[DONE]" {
			continue
		}
		var event map[string]any
		if err := json.Unmarshal([]byte(data), &event); err != nil {
			continue
		}
		typ := stringValue(event["type"])
		switch typ {
		case "response.output_text.delta":
			if !sentRole {
				writeChunk(map[string]any{"role": "assistant", "content": ""}, nil, nil)
				sentRole = true
			}
			if delta := stringValue(event["delta"]); delta != "" {
				writeChunk(map[string]any{"content": delta}, nil, nil)
			}
		case "response.reasoning.delta", "response.reasoning_text.delta":
			emitReasoning(reasoningKey("text", event["content_index"]), stringValue(event["delta"]))
		case "response.reasoning_summary_text.delta":
			emitReasoning(reasoningKey("summary", event["summary_index"]), stringValue(event["delta"]))
		case "response.reasoning_text.done":
			emitReasoning(reasoningKey("text", event["content_index"]), stringValue(event["text"]))
		case "response.reasoning_summary_text.done":
			emitReasoning(reasoningKey("summary", event["summary_index"]), stringValue(event["text"]))
		case "response.reasoning_summary_part.done":
			part, _ := event["part"].(map[string]any)
			text := stringValue(part["text"])
			if text == "" {
				text = stringValue(event["text"])
			}
			emitReasoning(reasoningKey("summary", event["summary_index"]), text)
		case "response.output_item.added":
			item, _ := event["item"].(map[string]any)
			if item["type"] == "function_call" {
				if !sentRole {
					writeChunk(map[string]any{"role": "assistant"}, nil, nil)
					sentRole = true
				}
				id := toChatCallID(defaultStringValue(item["call_id"], stringValue(item["id"])))
				writeChunk(map[string]any{"tool_calls": []any{map[string]any{"index": toolIndex, "id": id, "type": "function", "function": map[string]any{"name": stringValue(item["name"]), "arguments": ""}}}}, nil, nil)
			}
		case "response.function_call_arguments.delta", "response.custom_tool_call_input.delta":
			if delta := stringValue(event["delta"]); delta != "" {
				writeChunk(map[string]any{"tool_calls": []any{map[string]any{"index": toolIndex, "function": map[string]any{"arguments": delta}}}}, nil, nil)
			}
		case "response.function_call_arguments.done", "response.output_item.done":
			item, _ := event["item"].(map[string]any)
			if typ == "response.function_call_arguments.done" || item["type"] == "function_call" {
				toolIndex++
			} else if item["type"] == "reasoning" {
				reasoning.addItem(item, emitReasoning)
			}
		case "response.completed", "response.done":
			response, _ := event["response"].(map[string]any)
			if response == nil {
				response = event
			}
			usage := responseUsageToChatUsage(response["usage"])
			finish := "stop"
			if response["status"] == "incomplete" {
				finish = "length"
			}
			if toolIndex > 0 {
				finish = "tool_calls"
			}
			writeChunk(map[string]any{}, finish, usage)
		}
	}
	_, _ = writer.Write([]byte("data: [DONE]\n\n"))
}

func responseUsageToChatUsage(raw any) map[string]any {
	usage, _ := raw.(map[string]any)
	input := numberFromAny(usage["input_tokens"])
	if input == 0 {
		input = numberFromAny(usage["prompt_tokens"])
	}
	output := numberFromAny(usage["output_tokens"])
	if output == 0 {
		output = numberFromAny(usage["completion_tokens"])
	}
	out := map[string]any{"prompt_tokens": input, "completion_tokens": output, "total_tokens": input + output}
	cached := 0
	if details, ok := usage["input_tokens_details"].(map[string]any); ok {
		cached = numberFromAny(details["cached_tokens"])
	}
	if cached == 0 {
		if details, ok := usage["prompt_tokens_details"].(map[string]any); ok {
			cached = numberFromAny(details["cached_tokens"])
		}
	}
	if cached > 0 {
		out["prompt_tokens_details"] = map[string]any{"cached_tokens": cached}
	}
	reasoning := 0
	if details, ok := usage["output_tokens_details"].(map[string]any); ok {
		reasoning = numberFromAny(details["reasoning_tokens"])
	}
	if reasoning == 0 {
		if details, ok := usage["completion_tokens_details"].(map[string]any); ok {
			reasoning = numberFromAny(details["reasoning_tokens"])
		}
	}
	if reasoning > 0 {
		out["completion_tokens_details"] = map[string]any{"reasoning_tokens": reasoning}
	}
	return out
}

func responsesJSONToChatCompletion(data map[string]any, model string) map[string]any {
	content := ""
	reasoning := ""
	toolCalls := []any{}
	output, _ := data["output"].([]any)
	for _, raw := range output {
		item, _ := raw.(map[string]any)
		switch item["type"] {
		case "message":
			parts, _ := item["content"].([]any)
			for _, rawPart := range parts {
				part, _ := rawPart.(map[string]any)
				if part["type"] == "output_text" {
					content += stringValue(part["text"])
				}
			}
		case "reasoning":
			reasoning += extractReasoningFromItem(item)
		case "function_call":
			toolCalls = append(toolCalls, map[string]any{"id": toChatCallID(defaultStringValue(item["call_id"], stringValue(item["id"]))), "type": "function", "function": map[string]any{"name": stringValue(item["name"]), "arguments": defaultStringValue(item["arguments"], "{}")}})
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
	if data["status"] == "incomplete" {
		finish = "length"
	}
	if len(toolCalls) > 0 {
		finish = "tool_calls"
	}
	return map[string]any{"id": randomID("chatcmpl"), "object": "chat.completion", "created": time.Now().Unix(), "model": model, "choices": []any{map[string]any{"index": 0, "message": message, "finish_reason": finish}}, "usage": responseUsageToChatUsage(data["usage"])}
}

func extractReasoningFromItem(item map[string]any) string {
	if summary, ok := item["summary"].([]any); ok {
		if text := joinReasoningParts(summary); text != "" {
			return text
		}
	}
	if content, ok := item["content"].([]any); ok {
		if text := joinReasoningParts(content); text != "" {
			return text
		}
	}
	return stringValue(item["text"])
}

func joinReasoningParts(parts []any) string {
	chunks := []string{}
	for _, raw := range parts {
		if text, ok := raw.(string); ok {
			if text != "" {
				chunks = append(chunks, text)
			}
			continue
		}
		part, _ := raw.(map[string]any)
		if text := stringValue(part["text"]); text != "" {
			chunks = append(chunks, text)
		}
	}
	return strings.Join(chunks, "\n\n")
}

func numberFromAny(value any) int {
	switch v := value.(type) {
	case float64:
		return int(v)
	case int:
		return v
	case int64:
		return int(v)
	default:
		return 0
	}
}

func chatCompletionToResponsesJSON(data map[string]any, model string) map[string]any {
	choices, _ := data["choices"].([]any)
	message := map[string]any{}
	finishReason := "stop"
	if len(choices) > 0 {
		choice, _ := choices[0].(map[string]any)
		if choice != nil {
			if msg, _ := choice["message"].(map[string]any); msg != nil {
				message = msg
			}
			if fr := stringValue(choice["finish_reason"]); fr != "" {
				finishReason = fr
			}
		}
	}
	output := []any{}
	content := stringValue(message["content"])
	reasoning := stringValue(message["reasoning_content"])
	if reasoning != "" {
		output = append(output, responsesReasoningItem(reasoning))
	}
	if content != "" {
		output = append(output, responsesMessageItem(content))
	}
	if tcs, _ := message["tool_calls"].([]any); len(tcs) > 0 {
		for _, raw := range tcs {
			tc, _ := raw.(map[string]any)
			if tc == nil {
				continue
			}
			fn, _ := tc["function"].(map[string]any)
			name := stringValue(fn["name"])
			if name == "" {
				continue
			}
			id := toResponsesAPIID(stringValue(tc["id"]))
			output = append(output, responsesFunctionCallItem(id, name, defaultStringValue(fn["arguments"], "{}")))
		}
	}
	usage, _ := data["usage"].(map[string]any)
	status := "completed"
	var incompleteDetails any
	if finishReason == "length" {
		status = "incomplete"
		incompleteDetails = map[string]any{"reason": "max_output_tokens"}
	}
	response := map[string]any{
		"id":     randomID("resp"),
		"object": "response",
		"model":  model,
		"output": output,
		"status": status,
		"usage":  responsesUsageFromChat(usage),
	}
	if incompleteDetails != nil {
		response["incomplete_details"] = incompleteDetails
	}
	return response
}

func responsesReasoningItem(text string) map[string]any {
	return map[string]any{
		"id":      randomID("rs"),
		"type":    "reasoning",
		"status":  "completed",
		"summary": []any{map[string]any{"type": "summary_text", "text": text}},
	}
}

func responsesMessageItem(text string) map[string]any {
	return map[string]any{
		"id":      randomID("msg"),
		"type":    "message",
		"role":    "assistant",
		"status":  "completed",
		"content": []any{map[string]any{"type": "output_text", "text": text, "annotations": []any{}}},
	}
}

func responsesFunctionCallItem(id, name, arguments string) map[string]any {
	return map[string]any{
		"id":        id,
		"type":      "function_call",
		"status":    "completed",
		"call_id":   id,
		"name":      name,
		"arguments": defaultStringValue(arguments, "{}"),
	}
}

// responsesUsageFromChat maps Chat Completions usage onto the Responses usage
// shape. OpenAI includes cached tokens inside input_tokens, and pi subtracts
// input_tokens_details.cached_tokens to report cache reads.
func responsesUsageFromChat(usage map[string]any) map[string]any {
	input := numberFromAny(usage["prompt_tokens"])
	output := numberFromAny(usage["completion_tokens"])
	cached := 0
	if details, ok := usage["prompt_tokens_details"].(map[string]any); ok {
		cached = numberFromAny(details["cached_tokens"])
	}
	reasoning := 0
	if details, ok := usage["completion_tokens_details"].(map[string]any); ok {
		reasoning = numberFromAny(details["reasoning_tokens"])
	}
	return map[string]any{
		"input_tokens":          input,
		"input_tokens_details":  map[string]any{"cached_tokens": cached},
		"output_tokens":         output,
		"output_tokens_details": map[string]any{"reasoning_tokens": reasoning},
		"total_tokens":          input + output,
	}
}

// responsesSSEState tracks the output items emitted for a streamed Chat
// Completions response. The Responses protocol addresses items by
// output_index and requires a response.output_item.added event before any
// delta for that index, so items are opened lazily as content appears.
//
// Reasoning and text are sequential in the Chat Completions protocol and share
// one open slot. Tool calls are addressed by an explicit `index` and can
// interleave, so each index keeps its own open item.
type responsesSSEState struct {
	writer       func(map[string]any)
	model        string
	responseID   string
	sequence     int
	items        []map[string]any
	openKind     string
	openID       string
	openIndex    int
	openText     strings.Builder
	tools        map[int]*responsesOpenTool
	toolOrder    []int
	finishReason string
	usage        map[string]any
}

type responsesOpenTool struct {
	index int
	id    string
	name  string
	args  strings.Builder
}

func (s *responsesSSEState) emit(event map[string]any) {
	event["sequence_number"] = s.sequence
	s.sequence++
	s.writer(event)
}

func (s *responsesSSEState) appendItem(item map[string]any, index int) {
	s.emit(map[string]any{"type": "response.output_item.done", "output_index": index, "item": item})
	s.items = append(s.items, item)
}

func (s *responsesSSEState) closeOpenItem() {
	if s.openKind == "" {
		return
	}
	var item map[string]any
	switch s.openKind {
	case "reasoning":
		item = responsesReasoningItem(s.openText.String())
		item["id"] = s.openID
	case "text":
		item = responsesMessageItem(s.openText.String())
		item["id"] = s.openID
	}
	if item != nil {
		s.appendItem(item, s.openIndex)
	}
	s.openKind = ""
	s.openID = ""
	s.openText.Reset()
}

func (s *responsesSSEState) closeTool(index int) {
	tool, ok := s.tools[index]
	if !ok {
		return
	}
	s.appendItem(responsesFunctionCallItem(tool.id, tool.name, tool.args.String()), tool.index)
	delete(s.tools, index)
}

func (s *responsesSSEState) closeTools() {
	for _, index := range s.toolOrder {
		s.closeTool(index)
	}
	s.toolOrder = nil
}

func (s *responsesSSEState) closeAll() {
	s.closeTools()
	s.closeOpenItem()
}

func (s *responsesSSEState) ensureItem(kind, id string) {
	if s.openKind == kind && s.openID == id {
		return
	}
	s.closeTools()
	s.closeOpenItem()
	s.openKind = kind
	s.openID = id
	s.openIndex = len(s.items) + len(s.tools)
	var item map[string]any
	switch kind {
	case "reasoning":
		item = map[string]any{"id": id, "type": "reasoning", "status": "in_progress", "summary": []any{}}
	case "text":
		item = map[string]any{"id": id, "type": "message", "role": "assistant", "status": "in_progress", "content": []any{}}
	}
	s.emit(map[string]any{"type": "response.output_item.added", "output_index": s.openIndex, "item": item})
}

func (s *responsesSSEState) addReasoning(text string) {
	if text == "" {
		return
	}
	s.ensureItem("reasoning", "reasoning")
	s.openText.WriteString(text)
	s.emit(map[string]any{"type": "response.reasoning_text.delta", "delta": text, "item_id": s.openID, "output_index": s.openIndex, "content_index": 0})
}

func (s *responsesSSEState) addText(text string) {
	if text == "" {
		return
	}
	s.ensureItem("text", "message")
	s.openText.WriteString(text)
	s.emit(map[string]any{"type": "response.output_text.delta", "delta": text, "item_id": s.openID, "output_index": s.openIndex, "content_index": 0})
}

func (s *responsesSSEState) addToolDelta(index int, id, name, args string) {
	if s.tools == nil {
		s.tools = map[int]*responsesOpenTool{}
	}
	// Chat Completions streams tool call deltas that omit `id` on
	// continuation chunks, so only the first chunk for an index carries it.
	tool, ok := s.tools[index]
	if !ok {
		s.closeOpenItem()
		if id == "" {
			id = randomID("fc")
		}
		tool = &responsesOpenTool{index: len(s.items) + len(s.tools), id: id}
		s.tools[index] = tool
		s.toolOrder = append(s.toolOrder, index)
		s.emit(map[string]any{"type": "response.output_item.added", "output_index": tool.index, "item": map[string]any{"id": tool.id, "type": "function_call", "status": "in_progress", "call_id": tool.id, "name": name, "arguments": ""}})
	}
	if name != "" && tool.name == "" {
		tool.name = name
	}
	if args != "" {
		tool.args.WriteString(args)
		s.emit(map[string]any{"type": "response.function_call_arguments.delta", "delta": args, "item_id": tool.id, "output_index": tool.index})
	}
}

func (s *responsesSSEState) complete() {
	s.closeAll()
	response := map[string]any{
		"id":     s.responseID,
		"object": "response",
		"model":  s.model,
		"output": s.items,
		"status": "completed",
		"usage":  responsesUsageFromChat(s.usage),
	}
	eventType := "response.completed"
	if s.finishReason == "length" {
		response["status"] = "incomplete"
		response["incomplete_details"] = map[string]any{"reason": "max_output_tokens"}
		eventType = "response.incomplete"
	}
	s.emit(map[string]any{"type": eventType, "response": response})
}

func chatSSEToResponsesSSEReader(source io.Reader, model string) io.Reader {
	reader, writer := io.Pipe()
	go func() {
		transformChatSSEToResponses(source, writer, model)
		_ = writer.Close()
	}()
	return reader
}

// AdaptChatResponseToResponses reshapes a Chat Completions upstream response
// into the Responses API shape. Every provider that talks to a chat-completions
// upstream must call this when the client requested /v1/responses, otherwise
// Responses clients receive chat.completion payloads they cannot parse.
func AdaptChatResponseToResponses(resp *http.Response, model string, stream bool) (*http.Response, error) {
	if stream {
		return sseResponse(chatSSEToResponsesSSEReader(resp.Body, model), resp.Body), nil
	}
	var data map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		_ = resp.Body.Close()
		return nil, err
	}
	_ = resp.Body.Close()
	return jsonResponse(http.StatusOK, chatCompletionToResponsesJSON(data, model)), nil
}

// ResponsesNativeProvider is implemented by providers whose upstream already
// speaks the Responses API for a given model, so their responses must be passed
// through instead of being converted.
type ResponsesNativeProvider interface {
	ResponsesNative(model string) bool
}

// AdaptForResponsesClient converts an upstream Chat Completions response into
// the Responses API shape when the client requested /v1/responses. Providers
// whose upstream already speaks the Responses protocol are passed through.
//
// This lives here rather than in each provider so every provider, including
// ones with custom MakeRequest implementations, behaves consistently.
func AdaptForResponsesClient(provider Provider, resp *http.Response, payload map[string]any, stream bool) (*http.Response, error) {
	if _, wantsResponses := payload["_responsesInput"].([]any); !wantsResponses {
		return resp, nil
	}
	model := stringValue(payload["model"])
	if native, ok := provider.(ResponsesNativeProvider); ok && native.ResponsesNative(model) {
		return resp, nil
	}
	return AdaptChatResponseToResponses(resp, model, stream)
}

func transformChatSSEToResponses(source io.Reader, writer io.Writer, model string) {
	writeEvent := func(event map[string]any) {
		encoded, _ := json.Marshal(event)
		_, _ = writer.Write([]byte("data: " + string(encoded) + "\n\n"))
	}

	state := &responsesSSEState{
		writer:     writeEvent,
		model:      model,
		responseID: randomID("resp"),
		usage:      map[string]any{},
	}
	state.emit(map[string]any{"type": "response.created", "response": map[string]any{"id": state.responseID, "object": "response", "model": model, "status": "in_progress", "output": []any{}}})

	scanner := bufio.NewScanner(source)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "" || data == "[DONE]" {
			continue
		}
		var chunk map[string]any
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			continue
		}
		if usage, ok := chunk["usage"].(map[string]any); ok && len(usage) > 0 {
			state.usage = usage
		}
		choices, _ := chunk["choices"].([]any)
		if len(choices) == 0 {
			continue
		}
		choice, _ := choices[0].(map[string]any)
		if choice == nil {
			continue
		}
		if usage, ok := choice["usage"].(map[string]any); ok && len(usage) > 0 {
			state.usage = usage
		}
		delta, _ := choice["delta"].(map[string]any)
		if finishReason := stringValue(choice["finish_reason"]); finishReason != "" {
			state.finishReason = finishReason
		}

		if delta != nil {
			state.addReasoning(stringValue(delta["reasoning_content"]))
			state.addText(stringValue(delta["content"]))
			if tcs, _ := delta["tool_calls"].([]any); len(tcs) > 0 {
				for _, raw := range tcs {
					tc, _ := raw.(map[string]any)
					if tc == nil {
						continue
					}
					fn, _ := tc["function"].(map[string]any)
					id := toResponsesAPIID(stringValue(tc["id"]))
					state.addToolDelta(numberFromAny(tc["index"]), id, stringValue(fn["name"]), stringValue(fn["arguments"]))
				}
			}
		}

		if state.finishReason != "" {
			state.complete()
			return
		}
	}
	state.complete()
}
