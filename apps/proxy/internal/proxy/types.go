package proxy

import "net/http"

type ErrorFormatter string

const (
	FormatOpenAI    ErrorFormatter = "openai"
	FormatAnthropic ErrorFormatter = "anthropic"
)

type routeConfig struct {
	Endpoint             string
	Format               ErrorFormatter
	RateLimitStatusCode  int
	NoAccountsStatusCode int
	Parse                func(map[string]any) (parsedRequest, *routeError)
	Build                func(parsedRequest, string, bool, string) map[string]any
	HandleStream         func(streamContext) error
	HandleNonStream      func(nonStreamContext) error
}

type parsedRequest struct {
	ModelParam         string
	Stream             bool
	ProviderAccountID  *string
	ReasoningRequested bool
	MessagesForError   any
	ParamsForError     map[string]any
	RouteData          map[string]any
}

type routeError struct {
	Status  int
	Message string
	Type    string
	Param   *string
	Code    *string
}

type streamContext struct {
	Response       *http.Response
	AccountID      string
	Provider       string
	Writer         http.ResponseWriter
	Request        *http.Request
	RequestStartMS int64
	StartMS        int64
	UserID         string
	APIKeyID       string
	Model          string
}

type nonStreamContext struct {
	Response       *http.Response
	AccountID      string
	Provider       string
	Writer         http.ResponseWriter
	Request        *http.Request
	RequestStartMS int64
	StartMS        int64
	UserID         string
	APIKeyID       string
	Model          string
}

type openAIError struct {
	Error openAIErrorInfo `json:"error"`
}

type openAIErrorInfo struct {
	Message      string  `json:"message"`
	Type         string  `json:"type"`
	Param        *string `json:"param"`
	Code         *string `json:"code"`
	RetryAfter   *string `json:"retry_after,omitempty"`
	RetryAfterMS *int64  `json:"retry_after_ms,omitempty"`
}
