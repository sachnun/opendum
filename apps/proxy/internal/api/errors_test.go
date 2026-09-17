package api

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"
)

func TestWriteOpenAIErrorDefaultsType(t *testing.T) {
	t.Parallel()
	recorder := httptest.NewRecorder()
	WriteOpenAIError(recorder, http.StatusBadRequest, ErrorInfo{Message: "bad"})

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusBadRequest)
	}
	if got := recorder.Header().Get("Content-Type"); got != "application/json" {
		t.Fatalf("Content-Type = %q, want application/json", got)
	}
	var body struct {
		Error ErrorInfo `json:"error"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Error.Message != "bad" {
		t.Fatalf("message = %q, want bad", body.Error.Message)
	}
	if body.Error.Type != "invalid_request_error" {
		t.Fatalf("type = %q, want default invalid_request_error", body.Error.Type)
	}
}

func TestWriteOpenAIErrorPreservesFields(t *testing.T) {
	t.Parallel()
	param := "model"
	code := "model_not_found"
	retryMS := int64(12000)
	recorder := httptest.NewRecorder()
	WriteOpenAIError(recorder, http.StatusTooManyRequests, ErrorInfo{
		Message:      "rate limited",
		Type:         "rate_limit_error",
		Param:        &param,
		Code:         &code,
		RetryAfterMS: &retryMS,
	})

	var body struct {
		Error ErrorInfo `json:"error"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Error.Type != "rate_limit_error" || body.Error.Message != "rate limited" {
		t.Fatalf("unexpected error body: %+v", body.Error)
	}
	if body.Error.Param == nil || *body.Error.Param != param {
		t.Fatalf("param = %v, want %q", body.Error.Param, param)
	}
	if body.Error.Code == nil || *body.Error.Code != code {
		t.Fatalf("code = %v, want %q", body.Error.Code, code)
	}
	if body.Error.RetryAfterMS == nil || *body.Error.RetryAfterMS != retryMS {
		t.Fatalf("retry_after_ms = %v, want %d", body.Error.RetryAfterMS, retryMS)
	}
}

func TestValidateInternalSignature(t *testing.T) {
	t.Parallel()
	const secret = "top-secret"
	path := "/internal/quota"
	body := []byte(`{"userId":"u"}`)

	sign := func(timestamp string) string { return signInternal(secret, timestamp, path, body) }

	now := strconv.FormatInt(time.Now().Unix(), 10)
	expired := strconv.FormatInt(time.Now().Add(-3*time.Minute).Unix(), 10)
	future := strconv.FormatInt(time.Now().Add(3*time.Minute).Unix(), 10)
	cases := []struct {
		name      string
		secret    string
		timestamp string
		signature string
		want      bool
	}{
		{"valid", secret, now, sign(now), true},
		{"wrong secret", "other", now, sign(now), false},
		{"empty secret", "", now, sign(now), false},
		{"missing headers", secret, "", "", false},
		{"non numeric timestamp", secret, "abc", sign("abc"), false},
		{"expired timestamp", secret, expired, sign(expired), false},
		{"future timestamp", secret, future, sign(future), false},
		{"invalid hex signature", secret, now, "zzzz", false},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body))
			req.Header.Set("X-Opendum-Internal-Timestamp", tc.timestamp)
			req.Header.Set("X-Opendum-Internal-Signature", tc.signature)
			server := &Server{secret: tc.secret}
			if got := server.validateInternalSignature(req, path, body); got != tc.want {
				t.Fatalf("validateInternalSignature = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestCopyInternalRelayHeadersBlocksSensitiveHeaders(t *testing.T) {
	t.Parallel()
	dst := http.Header{}
	copyInternalRelayHeaders(dst, map[string]string{
		"Authorization":       "Bearer token",
		"X-Custom":            "value",
		"Connection":          "keep-alive",
		"Host":                "evil.example",
		"Content-Length":      "10",
		"X-Forwarded-For":     "127.0.0.1",
		"Proxy-Authorization": "secret",
		"":                    "ignored",
	})
	if got := dst.Get("Authorization"); got != "Bearer token" {
		t.Errorf("Authorization = %q, want forwarded", got)
	}
	if got := dst.Get("X-Custom"); got != "value" {
		t.Errorf("X-Custom = %q, want forwarded", got)
	}
	for _, blocked := range []string{"Connection", "Host", "Content-Length", "X-Forwarded-For", "Proxy-Authorization"} {
		if got := dst.Get(blocked); got != "" {
			t.Errorf("%s = %q, want empty", blocked, got)
		}
	}
}

func TestCopyInternalRelayResponseHeadersBlocksSensitiveHeaders(t *testing.T) {
	t.Parallel()
	src := http.Header{
		"Content-Type":       []string{"application/json"},
		"X-Codex-Balance":    []string{"42"},
		"Content-Length":     []string{"10"},
		"Set-Cookie":         []string{"session=1"},
		"Connection":         []string{"keep-alive"},
		"Proxy-Authenticate": []string{"Basic"},
	}
	dst := http.Header{}
	copyInternalRelayResponseHeaders(dst, src)
	if got := dst.Get("Content-Type"); got != "application/json" {
		t.Errorf("Content-Type = %q, want forwarded", got)
	}
	if got := dst.Get("X-Codex-Balance"); got != "42" {
		t.Errorf("X-Codex-Balance = %q, want forwarded", got)
	}
	for _, blocked := range []string{"Content-Length", "Set-Cookie", "Connection", "Proxy-Authenticate"} {
		if got := dst.Get(blocked); got != "" {
			t.Errorf("%s = %q, want empty", blocked, got)
		}
	}
}

func signInternal(secret, timestamp, path string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(timestamp))
	_, _ = mac.Write([]byte("\n"))
	_, _ = mac.Write([]byte(path))
	_, _ = mac.Write([]byte("\n"))
	_, _ = mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}
