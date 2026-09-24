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

type finishReasonHealer struct {
	scanner           *bufio.Scanner
	pending           []byte
	done              bool
	sawChoices        bool
	sawFinish         bool
	sawToolCall       bool
	injectedFinish    bool
	toolCallArgs      strings.Builder
	currentToolCallID string
}

func newFinishReasonHealer(body io.Reader) *finishReasonHealer {
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	return &finishReasonHealer{scanner: scanner}
}

func (r *finishReasonHealer) Read(p []byte) (int, error) {
	doneLine := []byte("data: [DONE]")

	for len(r.pending) == 0 {
		if r.done {
			return 0, io.EOF
		}
		if !r.scanner.Scan() {
			if err := r.scanner.Err(); err != nil {
				return 0, err
			}
			r.done = true
			r.appendMissingFinish(false)
			if len(r.pending) == 0 {
				return 0, io.EOF
			}
			continue
		}
		line := append([]byte(nil), r.scanner.Bytes()...)
		r.trackLine(line)
		if bytes.Equal(line, doneLine) && !r.sawFinish {
			r.appendMissingFinish(true)
			if len(r.pending) > 0 {
				r.pending = append(r.pending, line...)
				r.pending = append(r.pending, '\n')
				continue
			}
		}
		r.pending = append(r.pending, line...)
		r.pending = append(r.pending, '\n')
	}
	n := copy(p, r.pending)
	r.pending = r.pending[n:]
	return n, nil
}

func (r *finishReasonHealer) trackLine(line []byte) {
	dataPrefix := []byte("data: ")
	doneLine := []byte("data: [DONE]")

	if !bytes.HasPrefix(line, dataPrefix) || bytes.Equal(line, doneLine) {
		return
	}
	jsonBytes := line[len(dataPrefix):]
	if !bytes.Contains(jsonBytes, []byte(`"choices"`)) {
		return
	}
	r.sawChoices = true
	if hasNonNullFinishReason(jsonBytes) {
		r.sawFinish = true
		return
	}
	if bytes.Contains(jsonBytes, []byte(`"tool_calls"`)) {
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
		r.pending = append(r.pending, `data: [DONE]`...)
		r.pending = append(r.pending, '\n')
	}
	slog.Warn("healed upstream stream without finish_reason", "finish_reason", finishReason)
}
