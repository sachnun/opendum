package proxy

import "strings"

type sseEvent struct {
	Data string
}

type sseScanner struct {
	buffer string
}

func (s *sseScanner) Process(chunk string, handle func(sseEvent)) {
	s.buffer += strings.ReplaceAll(chunk, "\r\n", "\n")
	events := strings.Split(s.buffer, "\n\n")
	s.buffer = events[len(events)-1]
	for _, event := range events[:len(events)-1] {
		processSSELines(strings.Split(event, "\n"), handle)
	}
}

func (s *sseScanner) Flush(handle func(sseEvent)) {
	if strings.TrimSpace(s.buffer) != "" {
		processSSELines(strings.Split(s.buffer, "\n"), handle)
	}
	s.buffer = ""
}

func processSSELines(lines []string, handle func(sseEvent)) {
	data := []string{}
	for _, line := range lines {
		if strings.HasPrefix(line, "data:") {
			data = append(data, strings.TrimSpace(strings.TrimPrefix(line, "data:")))
		}
	}
	if len(data) == 0 {
		return
	}
	payload := strings.Join(data, "\n")
	if payload != "" && payload != "[DONE]" {
		handle(sseEvent{Data: payload})
	}
}
