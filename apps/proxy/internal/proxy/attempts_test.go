package proxy

import (
	"net/http/httptest"
	"testing"
)

func TestSessionIDHeaderPrecedence(t *testing.T) {
	request := httptest.NewRequest("POST", "/v1/chat/completions", nil)
	request.Header.Set("session_id", "primary")
	request.Header.Set("x-session-id", "fallback")

	if got := sessionID(request); got != "primary" {
		t.Fatalf("sessionID = %q, want primary", got)
	}
}

func TestSessionIDFallsBackToXSessionID(t *testing.T) {
	request := httptest.NewRequest("POST", "/v1/chat/completions", nil)
	request.Header.Set("x-session-id", "fallback")

	if got := sessionID(request); got != "fallback" {
		t.Fatalf("sessionID = %q, want fallback", got)
	}
}
