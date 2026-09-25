package proxy

import (
	"bytes"
)

var (
	sseDataPrefix    = []byte("data:")
	sseDoubleNewline = []byte("\n\n")
	sseDoneData      = []byte("[DONE]")
)

// sseEvent carries one Server-Sent Event payload. Data aliases the scanner
// buffer and is only valid for the duration of the handler call, so handlers
// must not retain it.
type sseEvent struct {
	Data []byte
}

// sseScanner splits a byte stream into Server-Sent Events. It keeps the
// unconsumed tail in a reusable buffer so chunked input does not repeatedly
// concatenate and reallocate the whole pending event.
type sseScanner struct {
	buffer  []byte
	scratch []byte
}

func (s *sseScanner) Process(chunk []byte, handle func(sseEvent)) {
	if len(chunk) == 0 {
		return
	}
	if bytes.IndexByte(chunk, '\r') >= 0 {
		chunk = normalizeCRLF(chunk)
	}
	s.buffer = append(s.buffer, chunk...)

	start := 0
	for {
		index := bytes.Index(s.buffer[start:], sseDoubleNewline)
		if index < 0 {
			break
		}
		event := s.buffer[start : start+index]
		start += index + len(sseDoubleNewline)
		s.processEvent(event, handle)
	}
	if start > 0 {
		s.buffer = append(s.buffer[:0], s.buffer[start:]...)
	}
}

func (s *sseScanner) Flush(handle func(sseEvent)) {
	if len(trimASCIISpace(s.buffer)) > 0 {
		s.processEvent(s.buffer, handle)
	}
	s.buffer = s.buffer[:0]
}

// trimASCIISpace trims the ASCII whitespace an SSE line can carry. It avoids
// the Unicode table walk in bytes.TrimSpace on this hot path.
func trimASCIISpace(value []byte) []byte {
	start := 0
	for start < len(value) && isASCIISpace(value[start]) {
		start++
	}
	end := len(value)
	for end > start && isASCIISpace(value[end-1]) {
		end--
	}
	return value[start:end]
}

func isASCIISpace(b byte) bool {
	return b == ' ' || b == '\t' || b == '\n' || b == '\r' || b == '\v' || b == '\f'
}

func normalizeCRLF(chunk []byte) []byte {
	out := make([]byte, 0, len(chunk))
	for i := 0; i < len(chunk); i++ {
		if chunk[i] == '\r' && i+1 < len(chunk) && chunk[i+1] == '\n' {
			continue
		}
		out = append(out, chunk[i])
	}
	return out
}

func (s *sseScanner) processEvent(event []byte, handle func(sseEvent)) {
	var first []byte
	hasFirst := false
	multi := false
	for len(event) > 0 {
		line := event
		if index := bytes.IndexByte(event, '\n'); index >= 0 {
			line, event = event[:index], event[index+1:]
		} else {
			event = nil
		}
		if !bytes.HasPrefix(line, sseDataPrefix) {
			continue
		}
		value := trimASCIISpace(line[len(sseDataPrefix):])
		if !hasFirst {
			first, hasFirst = value, true
			continue
		}
		if !multi {
			multi = true
			s.scratch = append(s.scratch[:0], first...)
		}
		s.scratch = append(s.scratch, '\n')
		s.scratch = append(s.scratch, value...)
	}
	if !hasFirst {
		return
	}
	payload := first
	if multi {
		payload = s.scratch
	}
	if len(payload) > 0 && !bytes.Equal(payload, sseDoneData) {
		handle(sseEvent{Data: payload})
	}
	if multi {
		s.scratch = s.scratch[:0]
	}
}
