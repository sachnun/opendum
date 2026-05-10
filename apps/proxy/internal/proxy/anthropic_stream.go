package proxy

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"sort"
	"strconv"
	"time"
)

func (s *Service) anthropicNonStream(ctx responseContext) error {
	body, err := io.ReadAll(ctx.Response.Body)
	if err != nil {
		return err
	}
	var openAI map[string]any
	_ = json.Unmarshal(body, &openAI)
	response := transformOpenAIToAnthropic(openAI, ctx.Model, includeThinking(ctx.Request))
	inputTokens, outputTokens := usageFromJSON(openAI)
	ctx.Writer.Header().Set("Content-Type", "application/json")
	ctx.Writer.Header().Set("X-Provider-Account-Id", ctx.AccountID)
	ctx.Writer.WriteHeader(http.StatusOK)
	err = json.NewEncoder(ctx.Writer).Encode(response)
	durationMS := int(time.Now().UnixMilli() - ctx.StartMS)
	go s.recordSuccessfulRequest(context.Background(), ctx.AccountID, ctx.Provider, ctx.Model, ctx.UserID, ctx.APIKeyID, inputTokens, outputTokens, durationMS, false, ctx.RequestStartMS)
	return err
}

func (s *Service) anthropicStream(ctx responseContext) error {
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
	durationMS := int(time.Now().UnixMilli() - ctx.StartMS)
	go s.recordSuccessfulRequest(context.Background(), ctx.AccountID, ctx.Provider, ctx.Model, ctx.UserID, ctx.APIKeyID, tracker.inputTokens, tracker.outputTokens, durationMS, true, ctx.RequestStartMS)
	return nil
}

type anthropicStreamTracker struct {
	writer            http.ResponseWriter
	flusher           http.Flusher
	scanner           sseScanner
	openBlockType     string
	blockIndex        int
	toolBlockByID     map[string]int
	toolBlockByIndex  map[int]anthropicToolBlock
	openToolBlocks    map[int]bool
	inputTokens       int
	outputTokens      int
	finishReason      string
	includeThinking   bool
	generatedToolUses int
}

type anthropicToolBlock struct {
	index int
	id    string
}

func (t *anthropicStreamTracker) Process(chunk string) {
	t.scanner.Process(chunk, t.processEvent)
}

func (t *anthropicStreamTracker) Flush() {
	t.scanner.Flush(t.processEvent)
}

func (t *anthropicStreamTracker) processEvent(event sseEvent) {
	var parsed map[string]any
	if json.Unmarshal([]byte(event.Data), &parsed) != nil {
		return
	}
	if usage, ok := parsed["usage"].(map[string]any); ok {
		if input := numberAsInt(usage["prompt_tokens"]); input > 0 {
			t.inputTokens = input
		} else if input := numberAsInt(usage["input_tokens"]); input > 0 {
			t.inputTokens = input
		}
		if output := numberAsInt(usage["completion_tokens"]); output > 0 {
			t.outputTokens = output
		} else if output := numberAsInt(usage["output_tokens"]); output > 0 {
			t.outputTokens = output
		}
	}
	choices, _ := parsed["choices"].([]any)
	if len(choices) == 0 {
		return
	}
	choice, _ := choices[0].(map[string]any)
	delta, _ := choice["delta"].(map[string]any)
	if t.includeThinking {
		if reasoning := stringValue(delta["reasoning_content"]); reasoning != "" {
			t.writeThinkingDelta(reasoning)
		}
	}
	if text := stringValue(delta["content"]); text != "" {
		t.writeTextDelta(text)
	}
	if calls, ok := delta["tool_calls"].([]any); ok {
		for _, raw := range calls {
			t.writeToolCallDelta(raw)
		}
	}
	if finish := stringValue(choice["finish_reason"]); finish != "" {
		t.finishReason = mapOpenAIFinishReasonToAnthropic(finish)
	}
}

func (t *anthropicStreamTracker) writeTextDelta(text string) {
	if t.openBlockType != "text" {
		t.closeOpenToolBlocks()
		t.closeOpenBlock()
		writeAnthropicEvent(t.writer, t.flusher, "content_block_start", map[string]any{"type": "content_block_start", "index": t.blockIndex, "content_block": map[string]any{"type": "text", "text": ""}})
		t.openBlockType = "text"
	}
	writeAnthropicEvent(t.writer, t.flusher, "content_block_delta", map[string]any{"type": "content_block_delta", "index": t.blockIndex, "delta": map[string]any{"type": "text_delta", "text": text}})
}

func (t *anthropicStreamTracker) writeThinkingDelta(thinking string) {
	if t.openBlockType != "thinking" {
		t.closeOpenToolBlocks()
		t.closeOpenBlock()
		writeAnthropicEvent(t.writer, t.flusher, "content_block_start", map[string]any{"type": "content_block_start", "index": t.blockIndex, "content_block": map[string]any{"type": "thinking", "thinking": ""}})
		t.openBlockType = "thinking"
	}
	writeAnthropicEvent(t.writer, t.flusher, "content_block_delta", map[string]any{"type": "content_block_delta", "index": t.blockIndex, "delta": map[string]any{"type": "thinking_delta", "thinking": thinking}})
}

func (t *anthropicStreamTracker) writeToolCallDelta(raw any) {
	call, _ := raw.(map[string]any)
	fn, _ := call["function"].(map[string]any)
	openAIIndex := numberAsInt(call["index"])
	id := stringValue(call["id"])
	if id == "" {
		id = stringValue(call["call_id"])
	}
	if id == "" && t.toolBlockByIndex != nil {
		id = t.toolBlockByIndex[openAIIndex].id
	}
	if id == "" {
		id = t.toolCallID(openAIIndex)
	}
	index := t.ensureToolBlock(openAIIndex, id, stringValue(fn["name"]))
	if arguments := stringValue(fn["arguments"]); arguments != "" {
		writeAnthropicEvent(t.writer, t.flusher, "content_block_delta", map[string]any{"type": "content_block_delta", "index": index, "delta": map[string]any{"type": "input_json_delta", "partial_json": arguments}})
	}
}

func (t *anthropicStreamTracker) ensureToolBlock(openAIIndex int, id, name string) int {
	t.closeOpenBlock()
	if t.toolBlockByID == nil {
		t.toolBlockByID = map[string]int{}
	}
	if t.toolBlockByIndex == nil {
		t.toolBlockByIndex = map[int]anthropicToolBlock{}
	}
	if t.openToolBlocks == nil {
		t.openToolBlocks = map[int]bool{}
	}
	if index, ok := t.toolBlockByID[id]; ok {
		return index
	}
	index := t.blockIndex
	t.blockIndex++
	t.toolBlockByID[id] = index
	t.toolBlockByIndex[openAIIndex] = anthropicToolBlock{index: index, id: id}
	t.openToolBlocks[index] = true
	writeAnthropicEvent(t.writer, t.flusher, "content_block_start", map[string]any{"type": "content_block_start", "index": index, "content_block": map[string]any{"type": "tool_use", "id": id, "name": name, "input": map[string]any{}}})
	return index
}

func (t *anthropicStreamTracker) toolCallID(index int) string {
	if index >= t.generatedToolUses {
		t.generatedToolUses = index + 1
	}
	if index < 0 {
		t.generatedToolUses++
		index = t.generatedToolUses
	}
	return "toolu_" + time.Now().Format("20060102150405") + "_" + strconv.Itoa(index)
}

func (t *anthropicStreamTracker) closeOpenBlock() {
	if t.openBlockType == "" {
		return
	}
	writeAnthropicEvent(t.writer, t.flusher, "content_block_stop", map[string]any{"type": "content_block_stop", "index": t.blockIndex})
	t.blockIndex++
	t.openBlockType = ""
}

func (t *anthropicStreamTracker) closeOpenToolBlocks() {
	if len(t.openToolBlocks) == 0 {
		return
	}
	indexes := make([]int, 0, len(t.openToolBlocks))
	for index := range t.openToolBlocks {
		indexes = append(indexes, index)
	}
	sort.Ints(indexes)
	for _, index := range indexes {
		writeAnthropicEvent(t.writer, t.flusher, "content_block_stop", map[string]any{"type": "content_block_stop", "index": index})
		delete(t.openToolBlocks, index)
	}
}

func (t *anthropicStreamTracker) Finish() {
	t.Flush()
	t.closeOpenBlock()
	t.closeOpenToolBlocks()
	stopReason := t.finishReason
	if stopReason == "" {
		stopReason = "end_turn"
	}
	writeAnthropicEvent(t.writer, t.flusher, "message_delta", map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": stopReason, "stop_sequence": nil}, "usage": map[string]any{"input_tokens": t.inputTokens, "output_tokens": t.outputTokens}})
	writeAnthropicEvent(t.writer, t.flusher, "message_stop", map[string]any{"type": "message_stop"})
}

func mapOpenAIFinishReasonToAnthropic(reason string) string {
	switch reason {
	case "length":
		return "max_tokens"
	case "tool_calls", "function_call":
		return "tool_use"
	default:
		return "end_turn"
	}
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
