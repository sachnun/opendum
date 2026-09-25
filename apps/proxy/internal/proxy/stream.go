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
	scanner               sseScanner
	inputTokens           int
	outputTokens          int
	cachedTokens          int
	cacheWriteTokens      int
	hypercreditsRemaining *float64
	hypercreditsCost      float64
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
	usage := usageObject(parsed)
	if len(usage) == 0 {
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
	cached, cacheWrite := usageCacheCounts(usage)
	if cached > 0 {
		t.cachedTokens = cached
	}
	if cacheWrite > 0 {
		t.cacheWriteTokens = cacheWrite
	}
	if remaining, ok := usage["remaining"].(map[string]any); ok {
		if value := numberAsFloat(remaining["hypercredits"]); value > 0 {
			t.hypercreditsRemaining = &value
		}
	}
	if cost, ok := usage["cost"].(map[string]any); ok {
		if value := numberAsFloat(cost["hypercredits"]); value > 0 {
			t.hypercreditsCost = value
		}
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
	reader := bufio.NewReader(newFinishReasonHealer(ctx.Response.Body))
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
	ctx.setUsage(tracker.inputTokens, tracker.outputTokens, tracker.cachedTokens, tracker.cacheWriteTokens)
	if ctx.Provider == "hyper" && (tracker.hypercreditsRemaining != nil || tracker.hypercreditsCost > 0) {
		go s.storeHypercreditsUsage(context.Background(), ctx.AccountID, tracker.hypercreditsRemaining, tracker.hypercreditsCost)
	}
	go s.recordSuccessfulRequest(context.Background(), ctx.AccountID, ctx.Provider, ctx.Model, ctx.UserID, ctx.APIKeyID, tracker.inputTokens, tracker.outputTokens, tracker.cachedTokens, tracker.cacheWriteTokens, durationMS, true, ctx.RequestStartMS, ctx.UpstreamFirstResponseMS)
	return nil
}

func (s *Service) passthroughNonStream(ctx responseContext) error {
	body, err := io.ReadAll(ctx.Response.Body)
	if err != nil {
		return err
	}
	var parsed map[string]any
	_ = json.Unmarshal(body, &parsed)
	counts := usageFromJSON(parsed)
	if ctx.Provider == "hyper" {
		if usage, ok := parsed["usage"].(map[string]any); ok {
			var remaining *float64
			if remainingMap, ok := usage["remaining"].(map[string]any); ok {
				if value := numberAsFloat(remainingMap["hypercredits"]); value > 0 {
					remaining = &value
				}
			}
			var cost float64
			if costMap, ok := usage["cost"].(map[string]any); ok {
				cost = numberAsFloat(costMap["hypercredits"])
			}
			if remaining != nil || cost > 0 {
				go s.storeHypercreditsUsage(context.Background(), ctx.AccountID, remaining, cost)
			}
		}
	}
	ctx.Writer.Header().Set("Content-Type", "application/json")
	ctx.Writer.Header().Set("X-Provider-Account-Id", ctx.AccountID)
	ctx.Writer.WriteHeader(http.StatusOK)
	_, _ = io.Copy(ctx.Writer, bytes.NewReader(body))
	durationMS := int(time.Now().UnixMilli() - ctx.StartMS)
	ctx.setUsage(counts.inputTokens, counts.outputTokens, counts.cachedTokens, counts.cacheWriteTokens)
	go s.recordSuccessfulRequest(context.Background(), ctx.AccountID, ctx.Provider, ctx.Model, ctx.UserID, ctx.APIKeyID, counts.inputTokens, counts.outputTokens, counts.cachedTokens, counts.cacheWriteTokens, durationMS, false, ctx.RequestStartMS, ctx.UpstreamFirstResponseMS)
	return nil
}

type usageCounts struct {
	inputTokens      int
	outputTokens     int
	cachedTokens     int
	cacheWriteTokens int
}

func usageFromJSON(parsed map[string]any) usageCounts {
	usage := usageObject(parsed)
	if len(usage) == 0 {
		return usageCounts{}
	}
	counts := usageCounts{}
	if value := numberAsInt(usage["prompt_tokens"]); value > 0 {
		counts.inputTokens = value
	} else if value := numberAsInt(usage["input_tokens"]); value > 0 {
		counts.inputTokens = value
	}
	if value := numberAsInt(usage["completion_tokens"]); value > 0 {
		counts.outputTokens = value
	} else if value := numberAsInt(usage["output_tokens"]); value > 0 {
		counts.outputTokens = value
	}
	counts.cachedTokens, counts.cacheWriteTokens = usageCacheCounts(usage)
	return counts
}

// usageObject returns the usage object of a response body. Chat Completions
// exposes it at the top level while the Responses API nests it under the
// response object.
func usageObject(parsed map[string]any) map[string]any {
	if usage, ok := parsed["usage"].(map[string]any); ok {
		return usage
	}
	if response, ok := parsed["response"].(map[string]any); ok {
		if usage, ok := response["usage"].(map[string]any); ok {
			return usage
		}
	}
	return nil
}

// usageCacheCounts reads cache-read and cache-write token counts using the
// fields each endpoint exposes: Chat Completions nests them under
// prompt_tokens_details, Responses nests them under input_tokens_details, and
// Anthropic Messages exposes cache_read_input_tokens and
// cache_creation_input_tokens.
func usageCacheCounts(usage map[string]any) (int, int) {
	promptDetails, _ := usage["prompt_tokens_details"].(map[string]any)
	inputDetails, _ := usage["input_tokens_details"].(map[string]any)
	cached := numberAsInt(promptDetails["cached_tokens"])
	if cached == 0 {
		cached = numberAsInt(inputDetails["cached_tokens"])
	}
	write := numberAsInt(promptDetails["cache_write_tokens"])
	if write == 0 {
		write = numberAsInt(inputDetails["cache_write_tokens"])
	}
	if cached == 0 {
		cached = numberAsInt(usage["cache_read_input_tokens"])
	}
	if write == 0 {
		write = numberAsInt(usage["cache_creation_input_tokens"])
	}
	return cached, write
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

func numberAsFloat(value any) float64 {
	switch v := value.(type) {
	case float64:
		return v
	case int:
		return float64(v)
	case int64:
		return float64(v)
	default:
		return 0
	}
}
