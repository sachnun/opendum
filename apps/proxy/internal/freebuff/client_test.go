package freebuff

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestNewClientDefaultsAndTrims(t *testing.T) {
	t.Parallel()
	if client := NewClient(""); client.baseURL != DefaultBaseURL {
		t.Fatalf("empty baseURL = %q, want default", client.baseURL)
	}
	if client := NewClient(" https://example.test/ "); client.baseURL != "https://example.test" {
		t.Fatalf("baseURL = %q, want trimmed", client.baseURL)
	}
}

func TestStartRun(t *testing.T) {
	t.Parallel()
	var captured *http.Request
	var body map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		captured = r
		_ = json.NewDecoder(r.Body).Decode(&body)
		_, _ = w.Write([]byte(`{"runId":"run_1"}`))
	}))
	defer server.Close()
	client := &Client{baseURL: server.URL, http: server.Client()}

	runID, err := client.StartRun(context.Background(), "tok", "user_1", "agent_1")
	if err != nil {
		t.Fatalf("StartRun: %v", err)
	}
	if runID != "run_1" {
		t.Fatalf("runID = %q, want run_1", runID)
	}
	if captured.Method != http.MethodPost || captured.URL.Path != "/api/v1/agent-runs" {
		t.Fatalf("request = %s %s", captured.Method, captured.URL.Path)
	}
	if got := captured.Header.Get("Authorization"); got != "Bearer tok" {
		t.Fatalf("Authorization = %q", got)
	}
	if got := captured.Header.Get(actingUserIDHeader); got != "user_1" {
		t.Fatalf("acting user header = %q", got)
	}
	if body["action"] != "START" || body["agentId"] != "agent_1" {
		t.Fatalf("body = %v", body)
	}
}

func TestStartRunErrors(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name   string
		status int
		body   string
	}{
		{"http error", http.StatusBadGateway, "boom"},
		{"invalid json", http.StatusOK, "not json"},
		{"missing run id", http.StatusOK, `{}`},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()
			client := &Client{baseURL: server.URL, http: server.Client()}
			if _, err := client.StartRun(context.Background(), "tok", "user_1", "agent_1"); err == nil {
				t.Fatal("error = nil, want error")
			}
		})
	}
}

func TestEndSession(t *testing.T) {
	t.Parallel()
	var captured *http.Request
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		captured = r
		_, _ = w.Write([]byte(`{"status":"ended","freebucksRefundPending":true,"freebucksRefund":2.5}`))
	}))
	defer server.Close()
	client := &Client{baseURL: server.URL, http: server.Client()}

	result, err := client.EndSession(context.Background(), "tok", "user_1", "inst_1")
	if err != nil {
		t.Fatalf("EndSession: %v", err)
	}
	if result.Status != "ended" || !result.RefundPending || result.Refund != 2.5 {
		t.Fatalf("result = %+v", result)
	}
	if captured.Method != http.MethodDelete {
		t.Fatalf("method = %q, want DELETE", captured.Method)
	}
	if got := captured.Header.Get("x-freebuff-instance-id"); got != "inst_1" {
		t.Fatalf("instance header = %q, want inst_1", got)
	}
}

func TestEndSessionHandlesNotFoundAndErrors(t *testing.T) {
	t.Parallel()
	t.Run("not found maps to none", func(t *testing.T) {
		t.Parallel()
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusNotFound)
		}))
		defer server.Close()
		result, err := (&Client{baseURL: server.URL, http: server.Client()}).EndSession(context.Background(), "tok", "u", "i")
		if err != nil {
			t.Fatalf("EndSession: %v", err)
		}
		if result.Status != string(statusNone) {
			t.Fatalf("status = %q, want none", result.Status)
		}
	})

	t.Run("server error", func(t *testing.T) {
		t.Parallel()
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte("boom"))
		}))
		defer server.Close()
		if _, err := (&Client{baseURL: server.URL, http: server.Client()}).EndSession(context.Background(), "tok", "u", "i"); err == nil {
			t.Fatal("error = nil, want error")
		}
	})

	t.Run("unconfirmed status", func(t *testing.T) {
		t.Parallel()
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(`{"status":"weird"}`))
		}))
		defer server.Close()
		if _, err := (&Client{baseURL: server.URL, http: server.Client()}).EndSession(context.Background(), "tok", "u", "i"); err == nil {
			t.Fatal("error = nil, want error for unconfirmed status")
		}
	})
}

func TestChat(t *testing.T) {
	t.Parallel()
	t.Run("success", func(t *testing.T) {
		t.Parallel()
		var captured *http.Request
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			captured = r
			_, _ = w.Write([]byte(`{"ok":true}`))
		}))
		defer server.Close()
		client := &Client{baseURL: server.URL, http: server.Client()}

		resp, apiErr, err := client.Chat(context.Background(), "tok", "user_1", []byte(`{"model":"m"}`))
		if err != nil {
			t.Fatalf("Chat: %v", err)
		}
		if resp.StatusCode != http.StatusOK || apiErr != nil {
			t.Fatalf("success resp/err = %d/%v", resp.StatusCode, apiErr)
		}
		if captured.URL.Path != "/api/v1/chat/completions" {
			t.Fatalf("path = %q", captured.URL.Path)
		}
		if got := captured.Header.Get("User-Agent"); got != chatUserAgent {
			t.Fatalf("chat User-Agent = %q", got)
		}
		if got := captured.Header.Get("Content-Type"); got != "application/json" {
			t.Fatalf("Content-Type = %q", got)
		}
		resp.Body.Close()
	})

	t.Run("error returns body", func(t *testing.T) {
		t.Parallel()
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte("bad request"))
		}))
		defer server.Close()
		client := &Client{baseURL: server.URL, http: server.Client()}

		resp, apiErr, err := client.Chat(context.Background(), "tok", "user_1", []byte(`{}`))
		if err != nil {
			t.Fatalf("Chat error path: %v", err)
		}
		if resp.StatusCode != http.StatusBadRequest || !strings.Contains(string(apiErr), "bad request") {
			t.Fatalf("error resp/body = %d/%q", resp.StatusCode, apiErr)
		}
	})
}

func TestCreateOrRefreshSessionDecodesStatus(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name       string
		status     int
		body       string
		wantStatus string
		wantErr    bool
	}{
		{"active", http.StatusOK, `{"status":"active","instanceId":"inst_1"}`, "active", false},
		{"not found", http.StatusNotFound, ``, string(statusNone), false},
		{"model locked conflict", http.StatusConflict, `{"status":"model_locked"}`, "model_locked", false},
		{"country blocked", http.StatusForbidden, `{"status":"country_blocked"}`, "country_blocked", false},
		{"server error", http.StatusInternalServerError, `{}`, "", true},
		{"missing status", http.StatusOK, `{}`, "", true},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if got := r.Header.Get("x-freebuff-model"); got != "deepseek/deepseek-v4-flash" {
					t.Errorf("model header = %q", got)
				}
				w.WriteHeader(tc.status)
				if tc.body != "" {
					_, _ = w.Write([]byte(tc.body))
				}
			}))
			defer server.Close()
			client := &Client{baseURL: server.URL, http: server.Client()}
			resp, err := client.CreateOrRefreshSession(context.Background(), "tok", "u", "deepseek/deepseek-v4-flash")
			if tc.wantErr {
				if err == nil {
					t.Fatal("error = nil, want error")
				}
				return
			}
			if err != nil {
				t.Fatalf("CreateOrRefreshSession: %v", err)
			}
			if resp.Status != tc.wantStatus {
				t.Fatalf("status = %q, want %q", resp.Status, tc.wantStatus)
			}
		})
	}
}

func TestNewResponse(t *testing.T) {
	t.Parallel()
	resp := NewResponse(http.StatusTooManyRequests, "slow down", 500*time.Millisecond)
	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	if got := resp.Header.Get("Retry-After"); got != "1" {
		t.Fatalf("Retry-After = %q, want 1 (clamped)", got)
	}
	body, _ := io.ReadAll(resp.Body)
	var parsed struct {
		Error struct {
			Message string `json:"message"`
			Type    string `json:"type"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if parsed.Error.Message != "slow down" || parsed.Error.Type != "rate_limit_error" {
		t.Fatalf("error body = %+v", parsed.Error)
	}
}

func TestErrorNilSafe(t *testing.T) {
	t.Parallel()
	var err *Error
	if err.Error() != "freebuff error" {
		t.Fatalf("nil error = %q", err.Error())
	}
}

func TestRetryableH2Request(t *testing.T) {
	t.Parallel()
	if retryableH2Request(&http.Request{Method: http.MethodGet}, nil) {
		t.Fatal("nil error should not be retryable")
	}
	if !retryableH2Request(&http.Request{Method: http.MethodPost}, errors.New("http2: protocol error")) {
		t.Fatal("http2 POST error should be retryable")
	}
	if !retryableH2Request(&http.Request{Method: http.MethodGet}, errors.New("boom")) {
		t.Fatal("idempotent GET should be retryable")
	}
	if retryableH2Request(&http.Request{Method: http.MethodPost}, errors.New("boom")) {
		t.Fatal("non-idempotent POST without http2 error should not be retryable")
	}
}
