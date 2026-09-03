package google

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/opendum/opendum/packages/ai/pkg/protocol"
)

type GenerateContentRequest struct {
	Contents          []ContentItem           `json:"contents"`
	SystemInstruction *ContentItem            `json:"systemInstruction,omitempty"`
	GenerationConfig  *GenerationConfig       `json:"generationConfig,omitempty"`
	Tools             []GeminiToolDeclaration `json:"tools,omitempty"`
	ToolConfig        any                     `json:"toolConfig,omitempty"`
}

type ContentItem struct {
	Role  string `json:"role"` // "user" or "model"
	Parts []Part `json:"parts"`
}

type Part struct {
	Text             string                `json:"text,omitempty"`
	InlineData       *Blob                 `json:"inlineData,omitempty"`
	FunctionCall     *GeminiFunctionCall   `json:"functionCall,omitempty"`
	FunctionResponse *GeminiFunctionResult `json:"functionResponse,omitempty"`
	Thought          bool                  `json:"thought,omitempty"`
}

type Blob struct {
	MimeType string `json:"mimeType"`
	Data     string `json:"data"` // base64
}

type GeminiFunctionCall struct {
	Name string         `json:"name"`
	Args map[string]any `json:"args"`
}

type GeminiFunctionResult struct {
	Name     string         `json:"name"`
	Response map[string]any `json:"response"`
}

type GenerationConfig struct {
	Temperature     *float64        `json:"temperature,omitempty"`
	TopP            *float64        `json:"topP,omitempty"`
	MaxOutputTokens *int            `json:"maxOutputTokens,omitempty"`
	StopSequences   []string        `json:"stopSequences,omitempty"`
	ThinkingConfig  *ThinkingConfig `json:"thinkingConfig,omitempty"`
}

type ThinkingConfig struct {
	ThinkingBudget int `json:"thinkingBudget,omitempty"`
}

type GeminiToolDeclaration struct {
	FunctionDeclarations []FunctionDeclaration `json:"functionDeclarations"`
}

type FunctionDeclaration struct {
	Name        string         `json:"name"`
	Description string         `json:"description,omitempty"`
	Parameters  map[string]any `json:"parameters,omitempty"`
}

// ParseGenerateContent parses Google Gemini /v1beta/models/{model}:generateContent
func ParseGenerateContent(modelName string, bodyBytes []byte) (*protocol.CanonicalRequest, error) {
	var req GenerateContentRequest
	if err := json.Unmarshal(bodyBytes, &req); err != nil {
		return nil, fmt.Errorf("invalid gemini content request: %w", err)
	}

	canReq := &protocol.CanonicalRequest{
		Model: modelName,
		Extra: map[string]any{},
	}

	if req.GenerationConfig != nil {
		canReq.Temperature = req.GenerationConfig.Temperature
		canReq.TopP = req.GenerationConfig.TopP
		canReq.MaxTokens = req.GenerationConfig.MaxOutputTokens
		canReq.Stop = req.GenerationConfig.StopSequences
		if req.GenerationConfig.ThinkingConfig != nil {
			canReq.Thinking = &protocol.ThinkingConfig{
				Enabled:      true,
				BudgetTokens: req.GenerationConfig.ThinkingConfig.ThinkingBudget,
			}
		}
	}

	// System instruction
	if req.SystemInstruction != nil {
		var parts []string
		for _, p := range req.SystemInstruction.Parts {
			if p.Text != "" {
				parts = append(parts, p.Text)
			}
		}
		canReq.System = strings.Join(parts, "\n")
	}

	// Tools
	for _, t := range req.Tools {
		for _, fn := range t.FunctionDeclarations {
			canReq.Tools = append(canReq.Tools, protocol.ToolDefinition{
				Type:        "function",
				Name:        fn.Name,
				Description: fn.Description,
				Parameters:  fn.Parameters,
			})
		}
	}

	// Contents
	for _, c := range req.Contents {
		role := protocol.RoleUser
		if c.Role == "model" {
			role = protocol.RoleAssistant
		}

		cMsg := protocol.Message{
			Role: role,
		}

		for _, p := range c.Parts {
			if p.Text != "" {
				cMsg.Parts = append(cMsg.Parts, protocol.ContentPart{
					Type: protocol.PartText,
					Text: p.Text,
				})
			}
			if p.FunctionCall != nil {
				argsJSON, _ := json.Marshal(p.FunctionCall.Args)
				cMsg.ToolCalls = append(cMsg.ToolCalls, protocol.ToolCall{
					ID:   p.FunctionCall.Name, // Gemini uses function name as ID or index
					Type: "function",
					Function: protocol.FunctionCall{
						Name:      p.FunctionCall.Name,
						Arguments: string(argsJSON),
					},
				})
			}
			if p.FunctionResponse != nil {
				resJSON, _ := json.Marshal(p.FunctionResponse.Response)
				cMsg.Parts = append(cMsg.Parts, protocol.ContentPart{
					Type: protocol.PartToolResult,
					ToolResult: &protocol.ToolResult{
						ToolCallID: p.FunctionResponse.Name,
						Content:    string(resJSON),
					},
				})
			}
		}

		canReq.Messages = append(canReq.Messages, cMsg)
	}

	return canReq, nil
}

// FormatCanonicalToGemini converts CanonicalResponse to Gemini JSON response
func FormatCanonicalToGemini(resp *protocol.CanonicalResponse) map[string]any {
	parts := []map[string]any{}

	if resp.Thinking != "" {
		parts = append(parts, map[string]any{
			"text":    resp.Thinking,
			"thought": true,
		})
	}

	if resp.Content != "" {
		parts = append(parts, map[string]any{
			"text": resp.Content,
		})
	}

	for _, tc := range resp.ToolCalls {
		var args map[string]any
		_ = json.Unmarshal([]byte(tc.Function.Arguments), &args)
		if args == nil {
			args = map[string]any{}
		}
		parts = append(parts, map[string]any{
			"functionCall": map[string]any{
				"name": tc.Function.Name,
				"args": args,
			},
		})
	}

	finishReason := "STOP"
	if len(resp.ToolCalls) > 0 {
		finishReason = "FUNCTION_CALL"
	}

	return map[string]any{
		"candidates": []map[string]any{
			{
				"content": map[string]any{
					"role":  "model",
					"parts": parts,
				},
				"finishReason": finishReason,
			},
		},
		"usageMetadata": map[string]any{
			"promptTokenCount":     resp.Usage.PromptTokens,
			"candidatesTokenCount": resp.Usage.CompletionTokens,
			"totalTokenCount":      resp.Usage.TotalTokens,
		},
	}
}
