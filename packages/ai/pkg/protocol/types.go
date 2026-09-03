package protocol

type Role string

const (
	RoleSystem    Role = "system"
	RoleUser      Role = "user"
	RoleAssistant Role = "assistant"
	RoleTool      Role = "tool"
)

type ContentPartType string

const (
	PartText       ContentPartType = "text"
	PartImage      ContentPartType = "image"
	PartThinking   ContentPartType = "thinking"
	PartToolCall   ContentPartType = "tool_call"
	PartToolResult ContentPartType = "tool_result"
)

type ImageSource struct {
	Type      string `json:"type,omitempty"`       // "base64" or "url"
	MediaType string `json:"media_type,omitempty"` // e.g. "image/png"
	Data      string `json:"data,omitempty"`       // raw base64 or URL
}

type FunctionCall struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

type ToolCall struct {
	ID       string       `json:"id"`
	Type     string       `json:"type"` // usually "function"
	Function FunctionCall `json:"function"`
}

type ToolResult struct {
	ToolCallID string `json:"tool_call_id"`
	Content    string `json:"content"`
	IsError    bool   `json:"is_error,omitempty"`
}

type ContentPart struct {
	Type       ContentPartType `json:"type"`
	Text       string          `json:"text,omitempty"`
	Thinking   string          `json:"thinking,omitempty"`
	Signature  string          `json:"signature,omitempty"`
	Image      *ImageSource    `json:"image,omitempty"`
	ToolCall   *ToolCall       `json:"tool_call,omitempty"`
	ToolResult *ToolResult     `json:"tool_result,omitempty"`
}

type Message struct {
	Role       Role          `json:"role"`
	Parts      []ContentPart `json:"parts"`
	ToolCalls  []ToolCall    `json:"tool_calls,omitempty"`
	ToolCallID string        `json:"tool_call_id,omitempty"` // For standalone tool output
}

type ThinkingConfig struct {
	Enabled      bool   `json:"enabled"`
	BudgetTokens int    `json:"budget_tokens,omitempty"`
	Effort       string `json:"effort,omitempty"` // "low", "medium", "high"
}

type ToolDefinition struct {
	Type        string         `json:"type"` // "function"
	Name        string         `json:"name"`
	Description string         `json:"description,omitempty"`
	Parameters  map[string]any `json:"parameters,omitempty"`
}

type CanonicalRequest struct {
	Model       string           `json:"model"`
	Messages    []Message        `json:"messages"`
	System      string           `json:"system,omitempty"`
	Stream      bool             `json:"stream"`
	Temperature *float64         `json:"temperature,omitempty"`
	TopP        *float64         `json:"top_p,omitempty"`
	MaxTokens   *int             `json:"max_tokens,omitempty"`
	Stop        []string         `json:"stop,omitempty"`
	Tools       []ToolDefinition `json:"tools,omitempty"`
	ToolChoice  any              `json:"tool_choice,omitempty"`
	Thinking    *ThinkingConfig  `json:"thinking,omitempty"`
	SessionID   string           `json:"session_id,omitempty"`
	Extra       map[string]any   `json:"extra,omitempty"`
}

type Usage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
	ThinkingTokens   int `json:"thinking_tokens,omitempty"`
}

type CanonicalResponse struct {
	ID           string        `json:"id"`
	Model        string        `json:"model"`
	Role         Role          `json:"role"`
	Content      string        `json:"content"`
	Thinking     string        `json:"thinking,omitempty"`
	ToolCalls    []ToolCall    `json:"tool_calls,omitempty"`
	StopReason   string        `json:"stop_reason,omitempty"`
	Usage        Usage         `json:"usage"`
	RawProviders []string      `json:"raw_providers,omitempty"`
}
