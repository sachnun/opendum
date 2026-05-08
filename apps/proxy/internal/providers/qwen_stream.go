package providers

import (
	"bufio"
	"encoding/json"
	"io"
	"strings"
)

type qwenThinkTagReadCloser struct {
	reader io.ReadCloser
	closer io.Closer
}

func (r *qwenThinkTagReadCloser) Read(p []byte) (int, error) {
	return r.reader.Read(p)
}

func (r *qwenThinkTagReadCloser) Close() error {
	_ = r.reader.Close()
	return r.closer.Close()
}

func newQwenThinkTagReader(source io.Reader) io.Reader {
	reader, writer := io.Pipe()
	go func() {
		transformQwenThinkTags(source, writer)
		_ = writer.Close()
	}()
	return reader
}

func transformQwenThinkTags(source io.Reader, out io.Writer) {
	scanner := bufio.NewScanner(source)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	inThinkingBlock := false

	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data: ") {
			_, _ = out.Write([]byte(line + "\n"))
			continue
		}

		jsonText := strings.TrimSpace(strings.TrimPrefix(line, "data: "))
		if jsonText == "[DONE]" {
			_, _ = out.Write([]byte(line + "\n"))
			continue
		}

		var parsed map[string]any
		if err := json.Unmarshal([]byte(jsonText), &parsed); err != nil {
			_, _ = out.Write([]byte(line + "\n"))
			continue
		}

		choices, _ := parsed["choices"].([]any)
		for _, rawChoice := range choices {
			choice, _ := rawChoice.(map[string]any)
			delta, _ := choice["delta"].(map[string]any)
			content, _ := delta["content"].(string)
			if content == "" {
				continue
			}

			processedContent, reasoningContent := splitQwenThinkContent(content, &inThinkingBlock)

			if reasoningContent != "" {
				delta["reasoning_content"] = reasoningContent
			}
			if processedContent != content {
				if processedContent == "" {
					delta["content"] = nil
				} else {
					delta["content"] = processedContent
				}
			}
		}

		encoded, err := json.Marshal(parsed)
		if err != nil {
			_, _ = out.Write([]byte(line + "\n"))
			continue
		}
		_, _ = out.Write([]byte("data: " + string(encoded) + "\n"))
	}
}

func splitQwenThinkContent(content string, inThinkingBlock *bool) (string, string) {
	processed := ""
	reasoning := ""
	remaining := content
	for remaining != "" {
		if !*inThinkingBlock {
			idx := strings.Index(remaining, "<think>")
			if idx == -1 {
				processed += remaining
				break
			}
			processed += remaining[:idx]
			remaining = remaining[idx+len("<think>"):]
			*inThinkingBlock = true
			continue
		}

		idx := strings.Index(remaining, "</think>")
		if idx == -1 {
			reasoning += remaining
			break
		}
		reasoning += remaining[:idx]
		remaining = remaining[idx+len("</think>"):]
		*inThinkingBlock = false
	}
	return processed, reasoning
}
