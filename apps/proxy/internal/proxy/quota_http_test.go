package proxy

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestGetJSONSendsRequestAndReadsBody(t *testing.T) {
	t.Parallel()
	var gotMethod, gotHeader, gotBody string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotHeader = r.Header.Get("X-Test")
		body, _ := io.ReadAll(r.Body)
		gotBody = string(body)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	resp, raw, err := getJSON(context.Background(), server.Client(), http.MethodPost, server.URL, map[string]string{"X-Test": "1"}, map[string]any{"a": 1})
	if err != nil {
		t.Fatalf("getJSON: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if string(raw) != `{"ok":true}` {
		t.Fatalf("raw = %q, want body", raw)
	}
	if gotMethod != http.MethodPost {
		t.Fatalf("method = %q, want POST", gotMethod)
	}
	if gotHeader != "1" {
		t.Fatalf("header = %q, want 1", gotHeader)
	}
	if gotBody != `{"a":1}` {
		t.Fatalf("body = %q, want encoded json", gotBody)
	}
}

func TestGetJSONReturnsResponseOnErrorStatus(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte("boom"))
	}))
	defer server.Close()

	resp, raw, err := getJSON(context.Background(), server.Client(), http.MethodGet, server.URL, nil, nil)
	if err != nil {
		t.Fatalf("getJSON: %v", err)
	}
	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", resp.StatusCode)
	}
	if string(raw) != "boom" {
		t.Fatalf("raw = %q, want boom", raw)
	}
}

func TestGetJSONRejectsInvalidTarget(t *testing.T) {
	t.Parallel()
	if _, _, err := getJSON(context.Background(), http.DefaultClient, http.MethodGet, "", nil, nil); err == nil {
		t.Fatal("empty target error = nil, want error")
	}
}
