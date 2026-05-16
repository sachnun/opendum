package api

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

type internalRoundTripFunc func(*http.Request) (*http.Response, error)

func (f internalRoundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

func signedInternalRefreshRequest(body []byte) *http.Request {
	req := httptest.NewRequest(http.MethodPost, "/internal/refresh", bytes.NewReader(body))
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	mac := hmac.New(sha256.New, []byte("test-secret"))
	_, _ = mac.Write([]byte(timestamp))
	_, _ = mac.Write([]byte("\n/internal/refresh\n"))
	_, _ = mac.Write(body)
	req.Header.Set("X-Opendum-Internal-Timestamp", timestamp)
	req.Header.Set("X-Opendum-Internal-Signature", hex.EncodeToString(mac.Sum(nil)))
	return req
}

func TestInternalRouteForwardsAllowedURL(t *testing.T) {
	previousClient := internalRelayClient
	defer func() { internalRelayClient = previousClient }()

	var capturedMethod string
	var capturedURL string
	var capturedAuth string
	var capturedConnection string
	internalRelayClient = &http.Client{Transport: internalRoundTripFunc(func(req *http.Request) (*http.Response, error) {
		capturedMethod = req.Method
		capturedURL = req.URL.String()
		capturedAuth = req.Header.Get("Authorization")
		capturedConnection = req.Header.Get("Connection")
		return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"application/json"}, "X-Codex-Primary-Used-Percent": []string{"12"}}, Body: io.NopCloser(strings.NewReader(`{"ok":true}`))}, nil
	})}

	recorder := httptest.NewRecorder()
	body := `{"url":"https://openrouter.ai/api/v1/models","method":"GET","headers":{"Authorization":"Bearer token","Connection":"keep-alive"}}`
	req := signedInternalRefreshRequest([]byte(body))

	(&Server{secret: "test-secret"}).internalRefreshRoute(recorder, req)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body = %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}
	if capturedMethod != http.MethodGet {
		t.Fatalf("method = %q, want %q", capturedMethod, http.MethodGet)
	}
	if capturedURL != "https://openrouter.ai/api/v1/models" {
		t.Fatalf("url = %q", capturedURL)
	}
	if capturedAuth != "Bearer token" {
		t.Fatalf("authorization = %q", capturedAuth)
	}
	if capturedConnection != "" {
		t.Fatalf("connection header forwarded: %q", capturedConnection)
	}
	if recorder.Header().Get("X-Codex-Primary-Used-Percent") != "12" {
		t.Fatalf("quota response header not relayed")
	}
	if strings.TrimSpace(recorder.Body.String()) != `{"ok":true}` {
		t.Fatalf("body = %q", recorder.Body.String())
	}
}

func TestInternalRouteRejectsBlockedHost(t *testing.T) {
	recorder := httptest.NewRecorder()
	body := []byte(`{"url":"https://example.com/models","method":"GET"}`)
	req := signedInternalRefreshRequest(body)

	(&Server{secret: "test-secret"}).internalRefreshRoute(recorder, req)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusBadRequest)
	}
}

func TestInternalRouteRejectsHTTPURL(t *testing.T) {
	recorder := httptest.NewRecorder()
	body := []byte(`{"url":"http://openrouter.ai/api/v1/models","method":"GET"}`)
	req := signedInternalRefreshRequest(body)

	(&Server{secret: "test-secret"}).internalRefreshRoute(recorder, req)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusBadRequest)
	}
}

func TestInternalRouteRejectsUserinfoURL(t *testing.T) {
	recorder := httptest.NewRecorder()
	body := []byte(`{"url":"https://token@openrouter.ai/api/v1/models","method":"GET"}`)
	req := signedInternalRefreshRequest(body)

	(&Server{secret: "test-secret"}).internalRefreshRoute(recorder, req)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusBadRequest)
	}
}

func TestInternalRouteForwardsPostBody(t *testing.T) {
	previousClient := internalRelayClient
	defer func() { internalRelayClient = previousClient }()

	var capturedBody string
	internalRelayClient = &http.Client{Transport: internalRoundTripFunc(func(req *http.Request) (*http.Response, error) {
		body, _ := io.ReadAll(req.Body)
		capturedBody = string(body)
		return &http.Response{StatusCode: http.StatusAccepted, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"accepted":true}`))}, nil
	})}

	recorder := httptest.NewRecorder()
	body := []byte(`{"url":"https://integrate.api.nvidia.com/v1/chat/completions","method":"POST","headers":{"Authorization":"Bearer token","Content-Type":"application/json"},"body":{"model":"unit","messages":[{"role":"user","content":"ping"}],"max_tokens":1,"stream":false}}`)
	req := signedInternalRefreshRequest(body)

	(&Server{secret: "test-secret"}).internalRefreshRoute(recorder, req)

	if recorder.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want %d; body = %s", recorder.Code, http.StatusAccepted, recorder.Body.String())
	}
	if !strings.Contains(capturedBody, `"model":"unit"`) {
		t.Fatalf("body was not forwarded: %s", capturedBody)
	}
}

func TestInternalRouteForwardsKiroTokenExchange(t *testing.T) {
	previousClient := internalRelayClient
	defer func() { internalRelayClient = previousClient }()

	var capturedBody string
	var capturedUserAgent string
	internalRelayClient = &http.Client{Transport: internalRoundTripFunc(func(req *http.Request) (*http.Response, error) {
		capturedUserAgent = req.Header.Get("User-Agent")
		body, _ := io.ReadAll(req.Body)
		capturedBody = string(body)
		return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"accessToken":"access","refreshToken":"refresh","expiresIn":3600}`))}, nil
	})}

	recorder := httptest.NewRecorder()
	body := []byte(`{"url":"https://prod.us-east-1.auth.desktop.kiro.dev/oauth/token","method":"POST","headers":{"Content-Type":"application/json","Accept":"application/json","User-Agent":"KiroIDE"},"body":"{\"code\":\"abc\",\"code_verifier\":\"verifier\",\"redirect_uri\":\"http://localhost:49153/oauth/callback\"}"}`)
	req := signedInternalRefreshRequest(body)

	(&Server{secret: "test-secret"}).internalRefreshRoute(recorder, req)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body = %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}
	if capturedUserAgent != "KiroIDE" {
		t.Fatalf("user-agent = %q, want %q", capturedUserAgent, "KiroIDE")
	}
	if capturedBody != `{"code":"abc","code_verifier":"verifier","redirect_uri":"http://localhost:49153/oauth/callback"}` {
		t.Fatalf("body = %q", capturedBody)
	}
}
