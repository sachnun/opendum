package proxy

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"strings"
)

var (
	healerDoneLine   = []byte("data: [DONE]")
	healerDataPrefix = []byte("data: ")
	healerChoicesKey = []byte(`"choices"`)
	healerToolKey    = []byte(`"tool_calls"`)
)

const maxHealerLineBytes = 1 << 20

type finishReasonHealer struct {
	reader            *bufio.Reader
	pending           []byte
	offset            int
	done              bool
	sawChoices        bool
	sawFinish         bool
	sawToolCall       bool
	injectedFinish    bool
	toolCallArgs      strings.Builder
	currentToolCallID string
}

func newFinishReasonHealer(body io.Reader) *finishReasonHealer {
	return &finishReasonHealer{reader: bufio.NewReaderSize(body, 64*1024)}
}

func (r *finishReasonHealer) Read(p []byte) (int, error) {
	if r.offset == len(r.pending) {
		if err := r.fill(); err != nil {
			return 0, err
		}
	}
	n := copy(p, r.pending[r.offset:])
	r.offset += n
	if r.offset == len(r.pending) {
		r.pending = r.pending[:0]
		r.offset = 0
	}
	return n, nil
}

func (r *finishReasonHealer) fill() error {
	for r.offset == len(r.pending) {
		if r.done {
			return io.EOF
		}
		line, err := r.readLine()
		if err != nil && err != io.EOF {
			return err
		}
		if len(line) > 0 {
			r.trackLine(line)
			if bytes.Equal(line, healerDoneLine) && !r.sawFinish {
				r.appendMissingFinish(true)
				if len(r.pending) > 0 {
					r.pending = append(r.pending, line...)
					r.pending = append(r.pending, '\n')
					if err == io.EOF {
						r.done = true
					}
					continue
				}
			}
			r.pending = append(r.pending, line...)
			r.pending = append(r.pending, '\n')
		}
		if err == io.EOF {
			r.done = true
			r.appendMissingFinish(false)
			if len(r.pending) == 0 {
				return io.EOF
			}
			return nil
		}
	}
	return nil
}

// readLine returns one line without its trailing newline (and without a
// trailing carriage return, matching bufio.ScanLines). The returned slice
// aliases the reader buffer and is only valid until the next read, so callers
// must copy anything they keep. A non-empty final line is returned together
// with io.EOF, matching bufio.Scanner semantics.
func (r *finishReasonHealer) readLine() ([]byte, error) {
	line, err := r.reader.ReadSlice('\n')
	if err == bufio.ErrBufferFull {
		buffered := append([]byte(nil), line...)
		for err == bufio.ErrBufferFull {
			if len(buffered) > maxHealerLineBytes {
				return nil, fmt.Errorf("finish reason healer: line exceeds %d bytes", maxHealerLineBytes)
			}
			line, err = r.reader.ReadSlice('\n')
			buffered = append(buffered, line...)
		}
		return trimLineEnding(buffered), err
	}
	return trimLineEnding(line), err
}

func trimLineEnding(line []byte) []byte {
	if len(line) > 0 && line[len(line)-1] == '\n' {
		line = line[:len(line)-1]
	}
	if len(line) > 0 && line[len(line)-1] == '\r' {
		line = line[:len(line)-1]
	}
	return line
}

func (r *finishReasonHealer) trackLine(line []byte) {
	if !bytes.HasPrefix(line, healerDataPrefix) || bytes.Equal(line, healerDoneLine) {
		return
	}
	jsonBytes := line[len(healerDataPrefix):]
	if !bytes.Contains(jsonBytes, healerChoicesKey) {
		return
	}
	r.sawChoices = true
	if hasNonNullFinishReason(jsonBytes) {
		r.sawFinish = true
		return
	}
	if bytes.Contains(jsonBytes, healerToolKey) {
		r.sawToolCall = true
		r.accumulateToolCallArgs(jsonBytes)
	}
}

func hasNonNullFinishReason(jsonBytes []byte) bool {
	key := []byte(`"finish_reason"`)
	i := bytes.Index(jsonBytes, key)
	if i < 0 {
		return false
	}
	rest := bytes.TrimLeft(jsonBytes[i+len(key):], " \t\r\n")
	if len(rest) == 0 || rest[0] != ':' {
		return false
	}
	rest = bytes.TrimLeft(rest[1:], " \t\r\n")
	return len(rest) > 0 && rest[0] == '"'
}

func (r *finishReasonHealer) accumulateToolCallArgs(jsonBytes []byte) {
	var probe struct {
		Choices []struct {
			Delta struct {
				ToolCalls []struct {
					ID       string `json:"id"`
					Function struct {
						Arguments string `json:"arguments"`
					} `json:"function"`
					Arguments string `json:"arguments"`
				} `json:"tool_calls"`
			} `json:"delta"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(jsonBytes, &probe); err != nil {
		return
	}
	for _, choice := range probe.Choices {
		for _, toolCall := range choice.Delta.ToolCalls {
			if toolCall.ID != "" && toolCall.ID != r.currentToolCallID {
				r.currentToolCallID = toolCall.ID
				r.toolCallArgs.Reset()
			}
			if toolCall.Function.Arguments != "" {
				r.toolCallArgs.WriteString(toolCall.Function.Arguments)
			} else {
				r.toolCallArgs.WriteString(toolCall.Arguments)
			}
		}
	}
}

func (r *finishReasonHealer) toolCallComplete() bool {
	return strings.HasSuffix(strings.TrimSpace(r.toolCallArgs.String()), "}")
}

func (r *finishReasonHealer) appendMissingFinish(endedWithDone bool) {
	if !r.sawChoices || r.sawFinish || r.injectedFinish {
		return
	}
	var finishReason string
	switch {
	case r.sawToolCall:
		if !r.toolCallComplete() {
			return
		}
		finishReason = "tool_calls"
	case endedWithDone:
		finishReason = "stop"
	default:
		return
	}
	r.injectedFinish = true
	r.pending = append(r.pending, `data: `...)
	r.pending = append(r.pending, fmt.Sprintf(`{"choices":[{"delta":{},"finish_reason":%q,"index":0}]}`, finishReason)...)
	r.pending = append(r.pending, '\n')
	if !endedWithDone {
		r.pending = append(r.pending, healerDoneLine...)
		r.pending = append(r.pending, '\n')
	}
	slog.Warn("healed upstream stream without finish_reason", "finish_reason", finishReason)
}
