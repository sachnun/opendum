package proxy

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"time"
)

type openAIStreamUsageTracker struct {
	scanner      sseScanner
	inputTokens  int
	outputTokens int
}

func (t *openAIStreamUsageTracker) Process(chunk []byte) {
	t.scanner.Process(string(chunk), t.processEvent)
}

func (t *openAIStreamUsageTracker) Flush() {
	t.scanner.Flush(t.processEvent)
}

func (t *openAIStreamUsageTracker) processEvent(event sseEvent) {
	var parsed map[string]any
	if err := json.Unmarshal([]byte(event.Data), &parsed); err != nil {
		return
	}
	usage, ok := parsed["usage"].(map[string]any)
	if !ok {
		return
	}
	if value := numberAsInt(usage["prompt_tokens"]); value > 0 {
		t.inputTokens = value
	} else if value := numberAsInt(usage["input_tokens"]); value > 0 {
		t.inputTokens = value
	}
	if value := numberAsInt(usage["completion_tokens"]); value > 0 {
		t.outputTokens = value
	} else if value := numberAsInt(usage["output_tokens"]); value > 0 {
		t.outputTokens = value
	}
}

func (s *Service) passthroughStream(ctx responseContext) error {
	w := ctx.Writer
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.Header().Set("X-Provider-Account-Id", ctx.AccountID)
	w.WriteHeader(http.StatusOK)

	flusher, _ := w.(http.Flusher)
	tracker := &openAIStreamUsageTracker{}
	reader := bufio.NewReader(ctx.Response.Body)
	buf := make([]byte, 32*1024)
	for {
		n, err := reader.Read(buf)
		if n > 0 {
			chunk := buf[:n]
			tracker.Process(chunk)
			_, _ = w.Write(chunk)
			if flusher != nil {
				flusher.Flush()
			}
		}
		if err != nil {
			if err != io.EOF {
				break
			}
			break
		}
	}
	tracker.Flush()
	durationMS := int(time.Now().UnixMilli() - ctx.StartMS)
	go s.recordSuccessfulRequest(context.Background(), ctx.AccountID, ctx.Provider, ctx.Model, ctx.UserID, ctx.APIKeyID, tracker.inputTokens, tracker.outputTokens, durationMS, true, ctx.RequestStartMS)
	return nil
}

func (s *Service) passthroughNonStream(ctx responseContext) error {
	body, err := io.ReadAll(ctx.Response.Body)
	if err != nil {
		return err
	}
	var parsed map[string]any
	_ = json.Unmarshal(body, &parsed)
	inputTokens, outputTokens := usageFromJSON(parsed)
	ctx.Writer.Header().Set("Content-Type", "application/json")
	ctx.Writer.Header().Set("X-Provider-Account-Id", ctx.AccountID)
	ctx.Writer.WriteHeader(http.StatusOK)
	_, _ = io.Copy(ctx.Writer, bytes.NewReader(body))
	durationMS := int(time.Now().UnixMilli() - ctx.StartMS)
	go s.recordSuccessfulRequest(context.Background(), ctx.AccountID, ctx.Provider, ctx.Model, ctx.UserID, ctx.APIKeyID, inputTokens, outputTokens, durationMS, false, ctx.RequestStartMS)
	return nil
}

func usageFromJSON(parsed map[string]any) (int, int) {
	usage, ok := parsed["usage"].(map[string]any)
	if !ok {
		return 0, 0
	}
	input := numberAsInt(usage["prompt_tokens"])
	if input == 0 {
		input = numberAsInt(usage["input_tokens"])
	}
	output := numberAsInt(usage["completion_tokens"])
	if output == 0 {
		output = numberAsInt(usage["output_tokens"])
	}
	return input, output
}

func numberAsInt(value any) int {
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
