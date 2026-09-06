package providers

import "testing"

func TestOpenAICompatibleDefaultParams(t *testing.T) {
	p := openAICompatibleProvider{name: "custom", baseURL: "https://example.com/v1"}
	payload := p.buildPayload(map[string]any{
		"model":         "m",
		"temperature":   0.7,
		"max_tokens":    100,
		"unknown_param": "x",
	}, "m", "upstream-m", false)
	if payload["temperature"] != 0.7 {
		t.Errorf("temperature = %v, want 0.7", payload["temperature"])
	}
	if payload["max_tokens"] != 100 {
		t.Errorf("max_tokens = %v, want 100", payload["max_tokens"])
	}
	if _, ok := payload["unknown_param"]; ok {
		t.Errorf("unknown_param should be filtered out, got %v", payload["unknown_param"])
	}
	if payload["model"] != "upstream-m" {
		t.Errorf("model = %v, want upstream-m", payload["model"])
	}
	if payload["stream"] != false {
		t.Errorf("stream = %v, want false", payload["stream"])
	}
}

func TestOpenAICompatibleExplicitParamsOverrideDefault(t *testing.T) {
	p := openAICompatibleProvider{
		name:            "custom",
		baseURL:         "https://example.com/v1",
		supportedParams: set("model", "messages", "temperature"),
	}
	payload := p.buildPayload(map[string]any{
		"model":       "m",
		"temperature": 0.5,
		"max_tokens":  100,
	}, "m", "upstream-m", false)
	if payload["temperature"] != 0.5 {
		t.Errorf("temperature = %v, want 0.5", payload["temperature"])
	}
	if _, ok := payload["max_tokens"]; ok {
		t.Errorf("max_tokens should be filtered out by explicit params, got %v", payload["max_tokens"])
	}
}
