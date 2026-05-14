package proxy

import (
	"net/http"
	"time"
)

type ErrorFormatter string

const (
	FormatOpenAI    ErrorFormatter = "openai"
	FormatAnthropic ErrorFormatter = "anthropic"
)

type endpointAdapter struct {
	Endpoint             string
	Format               ErrorFormatter
	RateLimitStatusCode  int
	NoAccountsStatusCode int
	Parse                func(map[string]any) (parsedEndpointRequest, *routeError)
	Build                func(parsedEndpointRequest, string, bool, string) map[string]any
	HandleStream         func(responseContext) error
	HandleNonStream      func(responseContext) error
}

type parsedEndpointRequest struct {
	ModelParam         string
	Stream             bool
	ProviderAccountID  *string
	ReasoningRequested bool
	MessagesForError   any
	ParamsForError     map[string]any
	RouteData          map[string]any
}

type routeError struct {
	Status       int
	Message      string
	Type         string
	Param        *string
	Code         *string
	RetryAfter   *string
	RetryAfterMS *int64
}

type accountRotationFailure struct {
	AccountID string
	FailedAt  time.Time
}

type responseContext struct {
	Response                *http.Response
	AccountID               string
	Provider                string
	Writer                  http.ResponseWriter
	Request                 *http.Request
	RequestStartMS          int64
	UpstreamFirstResponseMS int64
	StartMS                 int64
	UserID                  string
	APIKeyID                string
	Model                   string
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
