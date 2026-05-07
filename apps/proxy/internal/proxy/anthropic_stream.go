package proxy

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
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
	writer          http.ResponseWriter
	flusher         http.Flusher
	scanner         sseScanner
	blockStarted    bool
	blockIndex      int
	inputTokens     int
	outputTokens    int
	includeThinking bool
}

func (t *anthropicStreamTracker) Process(chunk string) {
	t.scanner.Process(chunk, t.processEvent)
}

func (t *anthropicStreamTracker) processEvent(event sseEvent) {
	var parsed map[string]any
	if json.Unmarshal([]byte(event.Data), &parsed) != nil {
		return
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
		return
	}
	choice, _ := choices[0].(map[string]any)
	delta, _ := choice["delta"].(map[string]any)
	if text := stringValue(delta["content"]); text != "" {
		t.writeTextDelta(text)
	}
}

func (t *anthropicStreamTracker) writeTextDelta(text string) {
	if !t.blockStarted {
		writeAnthropicEvent(t.writer, t.flusher, "content_block_start", map[string]any{"type": "content_block_start", "index": t.blockIndex, "content_block": map[string]any{"type": "text", "text": ""}})
		t.blockStarted = true
	}
	writeAnthropicEvent(t.writer, t.flusher, "content_block_delta", map[string]any{"type": "content_block_delta", "index": t.blockIndex, "delta": map[string]any{"type": "text_delta", "text": text}})
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
