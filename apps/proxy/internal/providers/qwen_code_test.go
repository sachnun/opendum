package providers

import (
	"io"
	"strings"
	"testing"
)

func TestQwenCodeBuildPayloadFiltersParamsAndCleansTools(t *testing.T) {
	provider := qwenCodeProvider{}
	payload := provider.buildPayload(map[string]any{
		"model":       "qwen_code/qwen3-coder",
		"messages":    []any{map[string]any{"role": "user", "content": "hi"}},
		"temperature": 0.2,
		"unsupported": "drop-me",
		"stream":      false,
		"tools": []any{map[string]any{
			"type": "function",
			"function": map[string]any{
				"name":   "lookup",
				"strict": true,
				"parameters": map[string]any{
					"type":                 "object",
					"additionalProperties": false,
					"properties": map[string]any{
						"city": map[string]any{"type": "string", "strict": true},
					},
				},
			},
		}},
	}, true)

	if payload["model"] != "qwen3-coder" {
		t.Fatalf("model = %q, want qwen3-coder", payload["model"])
	}
	if payload["unsupported"] != nil {
		t.Fatalf("payload kept unsupported param: %#v", payload)
	}
	if payload["stream"] != true {
		t.Fatalf("stream = %v, want true", payload["stream"])
	}
	streamOptions := payload["stream_options"].(map[string]any)
	if streamOptions["include_usage"] != true {
		t.Fatalf("stream_options = %#v", streamOptions)
	}

	tools := payload["tools"].([]any)
	fn := tools[0].(map[string]any)["function"].(map[string]any)
	if _, ok := fn["strict"]; ok {
		t.Fatalf("function strict not removed: %#v", fn)
	}
	params := fn["parameters"].(map[string]any)
	if _, ok := params["additionalProperties"]; ok {
		t.Fatalf("additionalProperties not removed: %#v", params)
	}
	city := params["properties"].(map[string]any)["city"].(map[string]any)
	if _, ok := city["strict"]; ok {
		t.Fatalf("nested strict not removed: %#v", city)
	}
}

func TestQwenThinkTagTransform(t *testing.T) {
	input := strings.Join([]string{
		`data: {"choices":[{"delta":{"content":"hello <think>plan"}}]}`,
		``,
		`data: {"choices":[{"delta":{"content":" more</think> world"}}]}`,
		``,
		`data: [DONE]`,
		``,
	}, "\n")

	out, err := io.ReadAll(newQwenThinkTagReader(strings.NewReader(input)))
	if err != nil {
		t.Fatal(err)
	}
	text := string(out)
	if !strings.Contains(text, `"content":"hello "`) || !strings.Contains(text, `"reasoning_content":"plan"`) {
		t.Fatalf("first transformed chunk missing content/reasoning: %s", text)
	}
	if !strings.Contains(text, `"content":" world"`) || !strings.Contains(text, `"reasoning_content":" more"`) {
		t.Fatalf("second transformed chunk missing content/reasoning: %s", text)
	}
	if !strings.Contains(text, "data: [DONE]") {
		t.Fatalf("done marker missing: %s", text)
	}
}
