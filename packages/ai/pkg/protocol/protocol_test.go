package protocol_test

import (
	"encoding/json"
	"testing"

	"github.com/opendum/opendum/packages/ai/pkg/protocol"
	"github.com/opendum/opendum/packages/ai/pkg/protocol/anthropic"
	"github.com/opendum/opendum/packages/ai/pkg/protocol/google"
	"github.com/opendum/opendum/packages/ai/pkg/protocol/openai"
)

func TestOpenAIToCanonicalAndBack(t *testing.T) {
	inputJSON := `{
		"model": "gpt-4o",
		"messages": [
			{"role": "system", "content": "You are a helpful assistant."},
			{"role": "user", "content": "Hello!"}
		],
		"temperature": 0.7,
		"max_tokens": 1000,
		"stream": false
	}`

	canReq, err := openai.ParseChatCompletions([]byte(inputJSON))
	if err != nil {
		t.Fatalf("failed to parse OpenAI request: %v", err)
	}

	if canReq.Model != "gpt-4o" {
		t.Errorf("expected model gpt-4o, got %s", canReq.Model)
	}
	if canReq.System != "You are a helpful assistant." {
		t.Errorf("expected system prompt to match, got %s", canReq.System)
	}
	if len(canReq.Messages) != 2 {
		t.Errorf("expected 2 messages, got %d", len(canReq.Messages))
	}

	formatted := openai.FormatCanonicalToOpenAI(canReq)
	if formatted["model"] != "gpt-4o" {
		t.Errorf("expected formatted model gpt-4o, got %v", formatted["model"])
	}
}

func TestAnthropicToCanonicalAndBack(t *testing.T) {
	inputJSON := `{
		"model": "claude-3-7-sonnet-20250219",
		"system": "Be concise.",
		"messages": [
			{"role": "user", "content": "What is 2+2?"}
		],
		"thinking": {
			"type": "enabled",
			"budget_tokens": 2048
		},
		"max_tokens": 4096
	}`

	canReq, err := anthropic.ParseMessages([]byte(inputJSON))
	if err != nil {
		t.Fatalf("failed to parse Anthropic request: %v", err)
	}

	if canReq.Model != "claude-3-7-sonnet-20250219" {
		t.Errorf("expected claude-3-7-sonnet-20250219, got %s", canReq.Model)
	}
	if canReq.Thinking == nil || !canReq.Thinking.Enabled {
		t.Fatalf("expected thinking to be enabled")
	}
	if canReq.Thinking.BudgetTokens != 2048 {
		t.Errorf("expected budget 2048, got %d", canReq.Thinking.BudgetTokens)
	}

	// Format response to Anthropic
	resp := &protocol.CanonicalResponse{
		ID:         "msg_123",
		Model:      canReq.Model,
		Content:    "The answer is 4.",
		Thinking:   "Calculating 2+2...",
		StopReason: "end_turn",
		Usage: protocol.Usage{
			PromptTokens:     10,
			CompletionTokens: 15,
		},
	}

	out := anthropic.FormatCanonicalToAnthropic(resp)
	if out["id"] != "msg_123" {
		t.Errorf("expected msg_123, got %v", out["id"])
	}
	blocks, ok := out["content"].([]map[string]any)
	if !ok || len(blocks) != 2 {
		t.Fatalf("expected 2 content blocks (thinking + text), got %#v", out["content"])
	}
	if blocks[0]["type"] != "thinking" || blocks[0]["thinking"] != "Calculating 2+2..." {
		t.Errorf("unexpected thinking block: %#v", blocks[0])
	}
	if blocks[1]["type"] != "text" || blocks[1]["text"] != "The answer is 4." {
		t.Errorf("unexpected text block: %#v", blocks[1])
	}
}

func TestGoogleGeminiToCanonicalAndBack(t *testing.T) {
	inputJSON := `{
		"contents": [
			{
				"role": "user",
				"parts": [{"text": "Hello Gemini!"}]
			}
		],
		"generationConfig": {
			"temperature": 0.4,
			"thinkingConfig": {
				"thinkingBudget": 1024
			}
		}
	}`

	canReq, err := google.ParseGenerateContent("gemini-2.5-flash", []byte(inputJSON))
	if err != nil {
		t.Fatalf("failed to parse Gemini request: %v", err)
	}

	if canReq.Model != "gemini-2.5-flash" {
		t.Errorf("expected gemini-2.5-flash, got %s", canReq.Model)
	}
	if canReq.Thinking == nil || canReq.Thinking.BudgetTokens != 1024 {
		t.Errorf("expected thinking budget 1024, got %#v", canReq.Thinking)
	}

	// Response formatting
	resp := &protocol.CanonicalResponse{
		ID:       "resp_gemini",
		Model:    canReq.Model,
		Content:  "Greetings from Gemini!",
		Thinking: "Thinking about greeting...",
		Usage: protocol.Usage{
			PromptTokens:     5,
			CompletionTokens: 8,
			TotalTokens:      13,
		},
	}

	out := google.FormatCanonicalToGemini(resp)
	outBytes, _ := json.Marshal(out)
	if len(outBytes) == 0 {
		t.Fatalf("failed to serialize Gemini response")
	}

	candidates, ok := out["candidates"].([]map[string]any)
	if !ok || len(candidates) == 0 {
		t.Fatalf("expected candidates in Gemini response")
	}
}
