package providers

import (
	"bufio"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestQoderEnvelopeDetectsErrors(t *testing.T) {
	// Captured from production: quota exhausted, HTTP 200 with an SSE envelope.
	raw := `{"headers":{"Content-Type":["application/json"]},"body":"{\"code\":\"112\",\"message\":\"{\\\"pricingUrl\\\":\\\"https://qoder.com/pricing?client=qoder\\\"}\"}","statusCodeValue":403,"statusCode":"FORBIDDEN"}`

	envelope := parseQoderEnvelope(raw)
	if !envelope.failed() {
		t.Fatal("FORBIDDEN envelope should be reported as failed")
	}
	status, message := envelope.errorStatus()
	if status != 403 {
		t.Fatalf("status = %d, want 403", status)
	}
	if !strings.Contains(message, "pricingUrl") {
		t.Fatalf("message = %q, want it to carry the upstream reason", message)
	}
	if envelope.isFinish() {
		t.Fatal("an error envelope is not a finish frame")
	}
}

func TestQoderEnvelopeDetectsSignatureError(t *testing.T) {
	raw := `{"body":"{\"code\":\"101\",\"message\":\"Signature invalid\"}","statusCodeValue":403,"statusCode":"FORBIDDEN"}`
	envelope := parseQoderEnvelope(raw)
	if !envelope.failed() {
		t.Fatal("signature error should be reported as failed")
	}
	if _, message := envelope.errorStatus(); message != "Signature invalid" {
		t.Fatalf("message = %q, want %q", message, "Signature invalid")
	}
}

func TestQoderEnvelopeAcceptsSuccess(t *testing.T) {
	raw := `{"body":"{\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}","statusCode":"OK"}`
	envelope := parseQoderEnvelope(raw)
	if envelope.failed() {
		t.Fatal("OK envelope must not be treated as failed")
	}
	if got := envelope.inner(); !strings.Contains(got, `"content":"hi"`) {
		t.Fatalf("inner = %q, want the wrapped chunk", got)
	}
}

func TestQoderEnvelopeDetectsFinish(t *testing.T) {
	for _, raw := range []string{
		`{"body":"{\"event\":\"finish\"}","statusCode":"OK"}`,
		`{"body":"{\"event\": \"finish\"}","statusCode":"OK"}`,
		`{"body":"{\"type\":\"event:finish\"}","statusCode":"OK"}`,
	} {
		if !parseQoderEnvelope(raw).isFinish() {
			t.Fatalf("envelope %s should be a finish frame", raw)
		}
	}
}

func TestQoderEnvelopeErrorWithoutBodyFallsBackToStatus(t *testing.T) {
	envelope := parseQoderEnvelope(`{"statusCode":"UNAUTHORIZED","statusCodeValue":401}`)
	if !envelope.failed() {
		t.Fatal("UNAUTHORIZED should be failed")
	}
	status, message := envelope.errorStatus()
	if status != 401 || message != "UNAUTHORIZED" {
		t.Fatalf("errorStatus = (%d, %q), want (401, UNAUTHORIZED)", status, message)
	}
}

func TestQoderSSEReaderStopsOnErrorEnvelope(t *testing.T) {
	// Real qoder behaviour: one error frame followed by an open connection.
	upstream := "data:" + `{"body":"{\"code\":\"112\"}","statusCodeValue":403,"statusCode":"FORBIDDEN"}` + "\n\n"

	out, err := io.ReadAll(qoderSSEToChatSSEReader(strings.NewReader(upstream), "m"))
	if err != nil {
		t.Fatalf("read error: %v", err)
	}
	text := string(out)
	if !strings.Contains(text, "Qoder:") {
		t.Fatalf("error was not surfaced: %s", text)
	}
	if !strings.HasSuffix(strings.TrimSpace(text), "data: [DONE]") {
		t.Fatalf("stream was not terminated with [DONE]: %s", text)
	}
}

func TestQoderSSEReaderStopsOnFinishEnvelope(t *testing.T) {
	upstream := strings.Join([]string{
		`data:{"body":"{\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}","statusCode":"OK"}`,
		"",
		`data:{"body":"{\"event\":\"finish\"}","statusCode":"OK"}`,
		"",
	}, "\n")

	out, err := io.ReadAll(qoderSSEToChatSSEReader(strings.NewReader(upstream), "m"))
	if err != nil {
		t.Fatalf("read error: %v", err)
	}
	text := string(out)
	if !strings.Contains(text, `"content":"hi"`) {
		t.Fatalf("content chunk missing: %s", text)
	}
	if !strings.HasSuffix(strings.TrimSpace(text), "data: [DONE]") {
		t.Fatalf("stream was not terminated with [DONE]: %s", text)
	}
}

func TestQoderPeekEnvelopeReadsFirstDataLine(t *testing.T) {
	raw := ": keep-alive\n\ndata:{\"statusCode\":\"OK\",\"body\":\"{}\"}\n\ndata:ignored\n\n"
	body := io.NopCloser(strings.NewReader(raw))
	resp := &http.Response{Body: body}
	reader := bufio.NewReader(body)

	payload, err := qoderPeekEnvelope(resp, reader, time.Second)
	if err != nil {
		t.Fatalf("peek error: %v", err)
	}
	if payload != `{"statusCode":"OK","body":"{}"}` {
		t.Fatalf("payload = %q", payload)
	}
	// The rest of the stream must remain readable for the caller.
	rest, _ := io.ReadAll(reader)
	if !strings.Contains(string(rest), "data:ignored") {
		t.Fatalf("remainder lost: %q", rest)
	}
}

func TestQoderPeekEnvelopeTimesOutOnSilentStream(t *testing.T) {
	blocking := &blockingReader{release: make(chan struct{})}
	body := io.NopCloser(blocking)
	resp := &http.Response{Body: body}
	reader := bufio.NewReader(body)

	start := time.Now()
	if _, err := qoderPeekEnvelope(resp, reader, 100*time.Millisecond); err == nil {
		t.Fatal("expected a timeout error for a silent stream")
	}
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Fatalf("peek took %s, want it to fail fast", elapsed)
	}
	close(blocking.release)
}

type blockingReader struct {
	release chan struct{}
}

func (b *blockingReader) Read([]byte) (int, error) {
	<-b.release
	return 0, io.EOF
}
