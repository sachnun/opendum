package proxy

import (
	"strings"
	"testing"
)

func collectSSE(scanner *sseScanner, chunks ...string) []string {
	events := []string{}
	handle := func(event sseEvent) { events = append(events, string(event.Data)) }
	for _, chunk := range chunks {
		scanner.Process([]byte(chunk), handle)
	}
	scanner.Flush(handle)
	return events
}

func TestSSEScannerSplitsEventsAcrossChunks(t *testing.T) {
	scanner := &sseScanner{}
	events := collectSSE(scanner,
		"data: {\"a\":1}\n\n",
		"data: {\"b\":",
		"2}\n\n",
	)
	want := []string{`{"a":1}`, `{"b":2}`}
	if len(events) != len(want) {
		t.Fatalf("events = %#v, want %#v", events, want)
	}
	for i := range want {
		if events[i] != want[i] {
			t.Fatalf("event %d = %q, want %q", i, events[i], want[i])
		}
	}
}

func TestSSEScannerFlushesTrailingEventWithoutBlankLine(t *testing.T) {
	scanner := &sseScanner{}
	events := collectSSE(scanner, `data: {"partial":true}`)
	if len(events) != 1 || events[0] != `{"partial":true}` {
		t.Fatalf("events = %#v, want one flushed event", events)
	}
}

func TestSSEScannerSkipsDoneAndEmptyPayloads(t *testing.T) {
	scanner := &sseScanner{}
	events := collectSSE(scanner, "data: [DONE]\n\n", "data:\n\n", ": keep-alive\n\n", "data: {}\n\n")
	if len(events) != 1 || events[0] != "{}" {
		t.Fatalf("events = %#v, want only {}", events)
	}
}

func TestSSEScannerNormalizesCRLFAndJoinsMultiLineData(t *testing.T) {
	scanner := &sseScanner{}
	events := collectSSE(scanner, "data: line1\r\ndata: line2\r\n\r\n")
	if len(events) != 1 || events[0] != "line1\nline2" {
		t.Fatalf("events = %#v, want joined multi-line data", events)
	}
}

func TestSSEScannerResetsBufferAfterFlush(t *testing.T) {
	scanner := &sseScanner{}
	events := collectSSE(scanner, "data: first\n\n")
	events = append(events, collectSSE(scanner, "data: second\n\n")...)
	if len(events) != 2 || events[0] != "first" || events[1] != "second" {
		t.Fatalf("events = %#v, want [first second]", events)
	}
}

func TestSSEScannerHandlesOneByteChunks(t *testing.T) {
	body := benchStreamBody(32)
	var got []string
	scanner := &sseScanner{}
	for i := 0; i < len(body); i++ {
		scanner.Process([]byte(body[i:i+1]), func(event sseEvent) { got = append(got, string(event.Data)) })
	}
	scanner.Flush(func(event sseEvent) { got = append(got, string(event.Data)) })
	if len(got) != 32 {
		t.Fatalf("events = %d, want 32", len(got))
	}
	for i, payload := range got {
		if !strings.Contains(payload, "hello world") {
			t.Fatalf("event %d = %q, want intact payload", i, payload)
		}
	}
}

func BenchmarkSSEScannerStreamingChunks(b *testing.B) {
	event := "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hello world\"}}]}\n\n"
	chunk := strings.Repeat(event, 8)
	b.SetBytes(int64(len(chunk)))
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		scanner := &sseScanner{}
		scanner.Process([]byte(chunk), func(sseEvent) {})
		scanner.Flush(func(sseEvent) {})
	}
}
