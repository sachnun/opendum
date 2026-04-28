package proxy

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
)

type passthroughUsageTracker struct {
	buffer       string
	inputTokens  int
	outputTokens int
}

func (t *passthroughUsageTracker) Process(chunk []byte) {
	t.buffer += string(chunk)
	events := strings.Split(t.buffer, "\n\n")
	t.buffer = events[len(events)-1]
	for _, event := range events[:len(events)-1] {
		t.processLines(strings.Split(event, "\n"))
	}
}

func (t *passthroughUsageTracker) Flush() {
	if strings.TrimSpace(t.buffer) != "" {
		t.processLines(strings.Split(t.buffer, "\n"))
	}
}

func (t *passthroughUsageTracker) processLines(lines []string) {
	for _, line := range lines {
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "" || data == "[DONE]" {
			continue
		}
		var parsed map[string]any
		if err := json.Unmarshal([]byte(data), &parsed); err != nil {
			continue
		}
		usage, ok := parsed["usage"].(map[string]any)
		if !ok {
			continue
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
}

func (s *Service) passthroughStream(ctx streamContext) error {
	w := ctx.Writer
	copyResponseHeaders(w.Header(), ctx.Response.Header)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.Header().Set("X-Provider-Account-Id", ctx.AccountID)
	w.WriteHeader(http.StatusOK)

	flusher, _ := w.(http.Flusher)
	tracker := &passthroughUsageTracker{}
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
	s.markAccountSuccess(context.Background(), ctx.AccountID, ctx.Model)
	s.recordLatency(context.Background(), ctx.Provider, ctx.Model, true, time.Now().UnixMilli()-ctx.RequestStartMS)
	s.logUsage(context.Background(), usageParams{UserID: ctx.UserID, ProviderAccountID: ctx.AccountID, ProxyAPIKeyID: ctx.APIKeyID, Model: ctx.Model, InputTokens: tracker.inputTokens, OutputTokens: tracker.outputTokens, StatusCode: http.StatusOK, DurationMS: int(time.Now().UnixMilli() - ctx.StartMS), Provider: ctx.Provider})
	return nil
}

func (s *Service) passthroughNonStream(ctx nonStreamContext) error {
	body, err := io.ReadAll(ctx.Response.Body)
	if err != nil {
		return err
	}
	var parsed map[string]any
	_ = json.Unmarshal(body, &parsed)
	inputTokens, outputTokens := usageFromJSON(parsed)
	s.markAccountSuccess(context.Background(), ctx.AccountID, ctx.Model)
	s.recordLatency(context.Background(), ctx.Provider, ctx.Model, false, time.Now().UnixMilli()-ctx.RequestStartMS)
	s.logUsage(context.Background(), usageParams{UserID: ctx.UserID, ProviderAccountID: ctx.AccountID, ProxyAPIKeyID: ctx.APIKeyID, Model: ctx.Model, InputTokens: inputTokens, OutputTokens: outputTokens, StatusCode: http.StatusOK, DurationMS: int(time.Now().UnixMilli() - ctx.StartMS), Provider: ctx.Provider})
	copyResponseHeaders(ctx.Writer.Header(), ctx.Response.Header)
	ctx.Writer.Header().Set("Content-Type", "application/json")
	ctx.Writer.Header().Set("X-Provider-Account-Id", ctx.AccountID)
	ctx.Writer.WriteHeader(http.StatusOK)
	_, _ = io.Copy(ctx.Writer, bytes.NewReader(body))
	return nil
}

func copyResponseHeaders(dst, src http.Header) {
	for key, values := range src {
		lower := strings.ToLower(key)
		if lower == "content-length" || lower == "content-encoding" || lower == "transfer-encoding" {
			continue
		}
		for _, value := range values {
			dst.Add(key, value)
		}
	}
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
