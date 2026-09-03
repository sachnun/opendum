package cleankey

import "testing"

func TestStripParamInfoKey(t *testing.T) {
	cases := map[string]string{
		"qwen3-235b-a22b":                     "qwen3",
		"mixtral-8x7b-v0.1":                   "mixtral-8x7b-v0.1",
		"llama-4-maverick-17b-128e-instruct":  "llama-4-maverick",
		"gemma-3-27b":                         "gemma-3",
		"llama-3.1-70b":                       "llama-3.1",
		"mistral-7b-instruct":                 "mistral",
		"qwen3-30b-a3b-fp8":                   "qwen3",
		"model-awq":                           "model",
		"model-q4":                            "model",
		"claude-opus-4-6-thinking":            "claude-opus-4-6",
		"mistral-large-3-675b-instruct-2512":  "mistral-large-3",
		"mistral-small-3.1-24b-instruct-2503": "mistral-small-3.1",
		"model-2024":                          "model-2024",
		"codestral-v0.1":                      "codestral-v0.1",
		"nemotron-nano-9b-v2":                 "nemotron-nano-v2",
		"mimo-v2.5":                           "mimo-v2.5",
		"qwen3-235b-a22b-thinking-2507":       "qwen3",
		"model-1234":                          "model-1234",
		"claude-opus-4-6":                     "claude-opus-4-6",
		"qwen3-coder":                         "qwen3-coder",
		"qwen3-vl":                            "qwen3-vl",
		"llama-3.2-vision-instruct":           "llama-3.2-vision",
		"qwen3-coder-free":                    "qwen3-coder-free",
		"qwen3_coder_30b_a3b_instruct":        "qwen3-coder",
		"qwen/qwen3-coder:free":               "qwen/qwen3-coder:free",
	}
	for in, want := range cases {
		if got := StripParamInfoKey(in); got != want {
			t.Errorf("StripParamInfoKey(%q) = %q, want %q", in, got, want)
		}
	}
	if got := StripParamInfoKey(""); got != "" {
		t.Errorf("empty = %q", got)
	}
}

func TestExtractDescriptors(t *testing.T) {
	got := ExtractDescriptors("claude-opus-4-6-thinking")
	if got["reasoning"] != true {
		t.Errorf("reasoning missing: %v", got)
	}
	got = ExtractDescriptors("qwen3-coder-30b-a3b-instruct")
	if got["code"] != true || got["type"] != "instruct" {
		t.Errorf("code/type missing: %v", got)
	}
	got = ExtractDescriptors("mistral-large-3-exp")
	if got["status"] != "experimental" {
		t.Errorf("status missing: %v", got)
	}
	if len(ExtractDescriptors("")) != 0 {
		t.Errorf("empty should be empty")
	}
}

func TestAliasesFromUpstream(t *testing.T) {
	got := AliasesFromUpstream([]string{"openai/gpt-4", "Qwen/Qwen3-32B"})
	want := []string{"openai-gpt-4", "openai/gpt-4", "Qwen-Qwen3-32B", "Qwen/Qwen3-32B"}
	if len(got) != len(want) {
		t.Fatalf("got %v want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v want %v", got, want)
		}
	}
	if len(AliasesFromUpstream(nil)) != 0 || len(AliasesFromUpstream([]string{})) != 0 {
		t.Errorf("empty should be empty")
	}
}

func TestLargestSizeValue(t *testing.T) {
	if v := LargestSizeValue("llama-3.3-70b-instruct"); v != 70 {
		t.Errorf("got %v", v)
	}
	if v := LargestSizeValue("qwen3-235b-a22b"); v != 235 {
		t.Errorf("got %v", v)
	}
	if v := LargestSizeValue("no-size-here"); v != 0 {
		t.Errorf("got %v", v)
	}
	if v := LargestSizeValue("model-1.5b"); v != 1.5 {
		t.Errorf("got %v", v)
	}
}
