package anthropic

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/opendum/opendum/packages/ai/pkg/protocol"
)

type MessagesRequest struct {
	Model       string                 `json:"model"`
	Messages    []MessageItem          `json:"messages"`
	System      any                    `json:"system,omitempty"` // string or []SystemPart
	MaxTokens   *int                   `json:"max_tokens,omitempty"`
	Temperature *float64               `json:"temperature,omitempty"`
	TopP        *float64               `json:"top_p,omitempty"`
	Stream      bool                   `json:"stream,omitempty"`
	Tools       []ToolItem             `json:"tools,omitempty"`
	ToolChoice  any                    `json:"tool_choice,omitempty"`
	Thinking    *AnthropicThinkingSpec `json:"thinking,omitempty"`
}

type AnthropicThinkingSpec struct {
	Type         string `json:"type"` // "enabled"
	BudgetTokens int    `json:"budget_tokens"`
}

type MessageItem struct {
	Role    string `json:"role"`
	Content any    `json:"content"` // string or []Block
}

type Block struct {
	Type      string         `json:"type"` // "text", "image", "thinking", "tool_use", "tool_result"
	Text      string         `json:"text,omitempty"`
	Thinking  string         `json:"thinking,omitempty"`
	Signature string         `json:"signature,omitempty"`
	ID        string         `json:"id,omitempty"`
	Name      string         `json:"name,omitempty"`
	Input     map[string]any `json:"input,omitempty"`
	Content   any            `json:"content,omitempty"`
	ToolUseID string         `json:"tool_use_id,omitempty"`
	IsError   bool           `json:"is_error,omitempty"`
	Source    *ImageSource   `json:"source,omitempty"`
}

type ImageSource struct {
	Type      string `json:"type"` // "base64"
	MediaType string `json:"media_type"`
	Data      string `json:"data"`
}

type ToolItem struct {
	Name        string         `json:"name"`
	Description string         `json:"description,omitempty"`
	InputSchema map[string]any `json:"input_schema"`
}

// ParseMessages converts Anthropic /v1/messages request to CanonicalRequest
func ParseMessages(bodyBytes []byte) (*protocol.CanonicalRequest, error) {
	var req MessagesRequest
	if err := json.Unmarshal(bodyBytes, &req); err != nil {
		return nil, fmt.Errorf("invalid anthropic messages json: %w", err)
	}

	canReq := &protocol.CanonicalRequest{
		Model:       req.Model,
		Stream:      req.Stream,
		Temperature: req.Temperature,
		TopP:        req.TopP,
		MaxTokens:   req.MaxTokens,
		ToolChoice:  req.ToolChoice,
		Extra:       map[string]any{},
	}

	// System prompt
	switch sys := req.System.(type) {
	case string:
		canReq.System = sys
	case []any:
		var texts []string
		for _, item := range sys {
			if m, ok := item.(map[string]any); ok {
				if t, _ := m["text"].(string); t != "" {
					texts = append(texts, t)
				}
			}
		}
		canReq.System = strings.Join(texts, "\n")
	}

	// Thinking
	if req.Thinking != nil && req.Thinking.Type == "enabled" {
		canReq.Thinking = &protocol.ThinkingConfig{
			Enabled:      true,
			BudgetTokens: req.Thinking.BudgetTokens,
		}
	}

	// Tools
	for _, t := range req.Tools {
		canReq.Tools = append(canReq.Tools, protocol.ToolDefinition{
			Type:        "function",
			Name:        t.Name,
			Description: t.Description,
			Parameters:  t.InputSchema,
		})
	}

	// Messages
	for _, m := range req.Messages {
		role := protocol.Role(m.Role)
		cMsg := protocol.Message{
			Role: role,
		}

		switch content := m.Content.(type) {
		case string:
			cMsg.Parts = append(cMsg.Parts, protocol.ContentPart{
				Type: protocol.PartText,
				Text: content,
			})
		case []any:
			for _, partAny := range content {
				partMap, ok := partAny.(map[string]any)
				if !ok {
					continue
				}
				bType, _ := partMap["type"].(string)
				switch bType {
				case "text":
					cMsg.Parts = append(cMsg.Parts, protocol.ContentPart{
						Type: protocol.PartText,
						Text: partMap["text"].(string),
					})
				case "thinking":
					cMsg.Parts = append(cMsg.Parts, protocol.ContentPart{
						Type:     protocol.PartThinking,
						Thinking: partMap["thinking"].(string),
					})
				case "tool_use":
					callID, _ := partMap["id"].(string)
					name, _ := partMap["name"].(string)
					inputBytes, _ := json.Marshal(partMap["input"])
					tc := protocol.ToolCall{
						ID:   callID,
						Type: "function",
						Function: protocol.FunctionCall{
							Name:      name,
							Arguments: string(inputBytes),
						},
					}
					cMsg.ToolCalls = append(cMsg.ToolCalls, tc)
				case "tool_result":
					toolUseID, _ := partMap["tool_use_id"].(string)
					var resContent string
					switch c := partMap["content"].(type) {
					case string:
						resContent = c
					default:
						b, _ := json.Marshal(c)
						resContent = string(b)
					}
					isErr, _ := partMap["is_error"].(bool)
					cMsg.Parts = append(cMsg.Parts, protocol.ContentPart{
						Type: protocol.PartToolResult,
						ToolResult: &protocol.ToolResult{
							ToolCallID: toolUseID,
							Content:    resContent,
							IsError:    isErr,
						},
					})
				}
			}
		}

		canReq.Messages = append(canReq.Messages, cMsg)
	}

	return canReq, nil
}

// FormatCanonicalToAnthropic converts CanonicalResponse to Anthropic JSON response
func FormatCanonicalToAnthropic(resp *protocol.CanonicalResponse) map[string]any {
	contentBlocks := []map[string]any{}

	if resp.Thinking != "" {
		contentBlocks = append(contentBlocks, map[string]any{
			"type":     "thinking",
			"thinking": resp.Thinking,
		})
	}

	if resp.Content != "" {
		contentBlocks = append(contentBlocks, map[string]any{
			"type": "text",
			"text": resp.Content,
		})
	}

	for _, tc := range resp.ToolCalls {
		var inputObj map[string]any
		_ = json.Unmarshal([]byte(tc.Function.Arguments), &inputObj)
		if inputObj == nil {
			inputObj = map[string]any{}
		}
		contentBlocks = append(contentBlocks, map[string]any{
			"type":  "tool_use",
			"id":    tc.ID,
			"name":  tc.Function.Name,
			"input": inputObj,
		})
	}

	stopReason := "end_turn"
	if len(resp.ToolCalls) > 0 {
		stopReason = "tool_use"
	} else if resp.StopReason != "" {
		stopReason = resp.StopReason
	}

	return map[string]any{
		"id":      resp.ID,
		"type":    "message",
		"role":    "assistant",
		"model":   resp.Model,
		"content": contentBlocks,
		"stop_reason": stopReason,
		"usage": map[string]any{
			"input_tokens":  resp.Usage.PromptTokens,
			"output_tokens": resp.Usage.CompletionTokens,
		},
	}
}
