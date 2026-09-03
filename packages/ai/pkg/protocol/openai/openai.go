package openai

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/opendum/opendum/packages/ai/pkg/protocol"
)

type ChatCompletionRequest struct {
	Model           string           `json:"model"`
	Messages        []ChatMessage    `json:"messages"`
	Stream          bool             `json:"stream,omitempty"`
	Temperature     *float64         `json:"temperature,omitempty"`
	TopP            *float64         `json:"top_p,omitempty"`
	MaxTokens       *int             `json:"max_tokens,omitempty"`
	Stop            any              `json:"stop,omitempty"` // string or []string
	Tools           []ChatTool       `json:"tools,omitempty"`
	ToolChoice      any              `json:"tool_choice,omitempty"`
	ReasoningEffort string           `json:"reasoning_effort,omitempty"`
	IncludeThoughts *bool            `json:"include_thoughts,omitempty"`
}

type ChatMessage struct {
	Role         string         `json:"role"`
	Content      any            `json:"content"` // string or []ContentPart
	Name         string         `json:"name,omitempty"`
	ToolCalls    []ChatToolCall `json:"tool_calls,omitempty"`
	ToolCallID   string         `json:"tool_call_id,omitempty"`
}

type ChatTool struct {
	Type     string       `json:"type"`
	Function ChatFunction `json:"function"`
}

type ChatFunction struct {
	Name        string         `json:"name"`
	Description string         `json:"description,omitempty"`
	Parameters  map[string]any `json:"parameters,omitempty"`
}

type ChatToolCall struct {
	ID       string               `json:"id"`
	Type     string               `json:"type"`
	Function ChatFunctionCallItem `json:"function"`
}

type ChatFunctionCallItem struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

// ParseChatCompletions converts an OpenAI ChatCompletion request to CanonicalRequest
func ParseChatCompletions(bodyBytes []byte) (*protocol.CanonicalRequest, error) {
	var req ChatCompletionRequest
	if err := json.Unmarshal(bodyBytes, &req); err != nil {
		return nil, fmt.Errorf("invalid json payload: %w", err)
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

	if req.ReasoningEffort != "" || (req.IncludeThoughts != nil && *req.IncludeThoughts) {
		canReq.Thinking = &protocol.ThinkingConfig{
			Enabled: true,
			Effort:  req.ReasoningEffort,
		}
	}

	// Parse tools
	for _, t := range req.Tools {
		canReq.Tools = append(canReq.Tools, protocol.ToolDefinition{
			Type:        t.Type,
			Name:        t.Function.Name,
			Description: t.Function.Description,
			Parameters:  t.Function.Parameters,
		})
	}

	// Parse messages
	for _, m := range req.Messages {
		role := protocol.Role(m.Role)
		if role == "developer" {
			role = protocol.RoleSystem
		}

		cMsg := protocol.Message{
			Role:       role,
			ToolCallID: m.ToolCallID,
		}

		for _, tc := range m.ToolCalls {
			cMsg.ToolCalls = append(cMsg.ToolCalls, protocol.ToolCall{
				ID:   tc.ID,
				Type: tc.Type,
				Function: protocol.FunctionCall{
					Name:      tc.Function.Name,
					Arguments: tc.Function.Arguments,
				},
			})
		}

		switch content := m.Content.(type) {
		case string:
			cMsg.Parts = append(cMsg.Parts, protocol.ContentPart{
				Type: protocol.PartText,
				Text: content,
			})
		case []any:
			for _, partAny := range content {
				if partMap, ok := partAny.(map[string]any); ok {
					pType, _ := partMap["type"].(string)
					switch pType {
					case "text":
						txt, _ := partMap["text"].(string)
						cMsg.Parts = append(cMsg.Parts, protocol.ContentPart{
							Type: protocol.PartText,
							Text: txt,
						})
					case "image_url":
						if imgURLMap, ok := partMap["image_url"].(map[string]any); ok {
							urlVal, _ := imgURLMap["url"].(string)
							cMsg.Parts = append(cMsg.Parts, protocol.ContentPart{
								Type: protocol.PartImage,
								Image: &protocol.ImageSource{
									Type: "url",
									Data: urlVal,
								},
							})
						}
					}
				}
			}
		}

		if cMsg.Role == protocol.RoleSystem && canReq.System == "" && len(cMsg.Parts) > 0 {
			canReq.System = cMsg.Parts[0].Text
		}

		canReq.Messages = append(canReq.Messages, cMsg)
	}

	return canReq, nil
}

// FormatCanonicalToOpenAI converts CanonicalRequest to OpenAI JSON payload
func FormatCanonicalToOpenAI(canReq *protocol.CanonicalRequest) map[string]any {
	payload := map[string]any{
		"model":  canReq.Model,
		"stream": canReq.Stream,
	}

	if canReq.Temperature != nil {
		payload["temperature"] = *canReq.Temperature
	}
	if canReq.TopP != nil {
		payload["top_p"] = *canReq.TopP
	}
	if canReq.MaxTokens != nil {
		payload["max_tokens"] = *canReq.MaxTokens
	}
	if canReq.ToolChoice != nil {
		payload["tool_choice"] = canReq.ToolChoice
	}

	if len(canReq.Tools) > 0 {
		tools := make([]map[string]any, 0, len(canReq.Tools))
		for _, t := range canReq.Tools {
			tools = append(tools, map[string]any{
				"type": "function",
				"function": map[string]any{
					"name":        t.Name,
					"description": t.Description,
					"parameters":  t.Parameters,
				},
			})
		}
		payload["tools"] = tools
	}

	messages := make([]map[string]any, 0, len(canReq.Messages))
	for _, m := range canReq.Messages {
		msg := map[string]any{
			"role": string(m.Role),
		}
		if m.ToolCallID != "" {
			msg["tool_call_id"] = m.ToolCallID
		}

		if len(m.ToolCalls) > 0 {
			calls := make([]map[string]any, 0, len(m.ToolCalls))
			for _, tc := range m.ToolCalls {
				calls = append(calls, map[string]any{
					"id":   tc.ID,
					"type": "function",
					"function": map[string]any{
						"name":      tc.Function.Name,
						"arguments": tc.Function.Arguments,
					},
				})
			}
			msg["tool_calls"] = calls
		}

		// Text parts
		var textParts []string
		for _, p := range m.Parts {
			if p.Type == protocol.PartText {
				textParts = append(textParts, p.Text)
			}
		}
		msg["content"] = strings.Join(textParts, "\n")
		messages = append(messages, msg)
	}

	payload["messages"] = messages
	return payload
}
