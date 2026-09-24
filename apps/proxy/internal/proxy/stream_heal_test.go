package proxy

import (
	"io"
	"strings"
	"testing"
)

func drainHealer(t *testing.T, body string) string {
	t.Helper()
	data, err := io.ReadAll(newFinishReasonHealer(strings.NewReader(body)))
	if err != nil {
		t.Fatalf("ReadAll: %v", err)
	}
	return string(data)
}

func TestHealerPassesNormalStreamUntouched(t *testing.T) {
	body := "data: {\"id\":\"c1\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"hi\"},\"finish_reason\":null}]}\n" +
		"data: {\"id\":\"c1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"!\"},\"finish_reason\":\"stop\"}]}\n" +
		"data: {\"id\":\"c1\",\"choices\":[],\"usage\":{\"total_tokens\":5}}\n" +
		"data: [DONE]\n"
	out := drainHealer(t, body)
	if strings.Count(out, "finish_reason\":\"stop\"") != 1 {
		t.Fatalf("expected the upstream finish_reason chunk preserved once, got:\n%s", out)
	}
	if !strings.Contains(out, "data: [DONE]") {
		t.Fatalf("expected [DONE] preserved, got:\n%s", out)
	}
	if strings.Contains(out, "\"finish_reason\":\"tool_calls\"") {
		t.Fatalf("unexpected synthesized tool_calls finish:\n%s", out)
	}
}

func TestHealerSynthesizesFinishAfterCompleteToolCallEOF(t *testing.T) {
	body := "data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"reasoning_content\":\"let me call\"},\"finish_reason\":null}]}\n" +
		"data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"get_time\",\"arguments\":\"{\\\"tz\\\":\\\"UTC\\\"}\"}}]},\"finish_reason\":null}]}\n"
	out := drainHealer(t, body)
	if !strings.Contains(out, "\"finish_reason\":\"tool_calls\"") {
		t.Fatalf("expected synthesized tool_calls finish after truncated EOF, got:\n%s", out)
	}
	if !strings.Contains(out, "data: [DONE]") {
		t.Fatalf("expected synthesized [DONE] after truncated EOF, got:\n%s", out)
	}
	if !strings.Contains(out, "call_1") || !strings.Contains(out, "get_time") {
		t.Fatalf("tool call content must be preserved, got:\n%s", out)
	}
}

func TestHealerSynthesizesStopBeforeDone(t *testing.T) {
	body := "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"done\"},\"finish_reason\":null}]}\n" +
		"data: [DONE]\n"
	out := drainHealer(t, body)
	finishIdx := strings.Index(out, "\"finish_reason\":\"stop\"")
	doneIdx := strings.Index(out, "data: [DONE]")
	if finishIdx < 0 || doneIdx < 0 || finishIdx > doneIdx {
		t.Fatalf("expected synthesized finish chunk before [DONE], got:\n%s", out)
	}
	if !strings.Contains(out, "\"content\":\"done\"") {
		t.Fatalf("content must be preserved, got:\n%s", out)
	}
}

func TestHealerLeavesBareEOFMidTextUntouched(t *testing.T) {
	body := "data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"partial answer\"},\"finish_reason\":null}]}\n"
	out := drainHealer(t, body)
	if strings.Contains(out, "\"finish_reason\":\"stop\"") {
		t.Fatalf("must not synthesize stop for bare EOF mid-text, got:\n%s", out)
	}
	if strings.Contains(out, "[DONE]") {
		t.Fatalf("must not synthesize [DONE] for bare EOF mid-text, got:\n%s", out)
	}
	if !strings.Contains(out, "partial answer") {
		t.Fatalf("content must be preserved, got:\n%s", out)
	}
}

func TestHealerLeavesIncompleteToolCallUntouched(t *testing.T) {
	body := "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"get_time\",\"arguments\":\"{\\\"tz\\\":\\\"UT\"}}]},\"finish_reason\":null}]}\n"
	out := drainHealer(t, body)
	if strings.Contains(out, "\"finish_reason\":\"tool_calls\"") {
		t.Fatalf("must not synthesize tool_calls for incomplete arguments, got:\n%s", out)
	}
	if strings.Contains(out, "[DONE]") {
		t.Fatalf("must not synthesize [DONE] for incomplete tool call, got:\n%s", out)
	}
}

func TestHealerLeavesNativeResponsesStreamUntouched(t *testing.T) {
	body := "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_1\"}}\n" +
		"data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"status\":\"completed\"}}\n"
	out := drainHealer(t, body)
	if out != body {
		t.Fatalf("native Responses stream must pass through untouched, got:\n%s", out)
	}
}
