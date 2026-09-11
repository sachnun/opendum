package providers

import (
	"context"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
)

type stubFallbackState struct {
	mu       sync.Mutex
	stickyOn bool
	calls    []string
}

func (s *stubFallbackState) sticky(context.Context, string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.stickyOn
}

func (s *stubFallbackState) recordStrike(context.Context, string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls = append(s.calls, "strike")
}

func (s *stubFallbackState) clear(context.Context, string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls = append(s.calls, "clear")
}

func TestFallbackUsesPrimaryWhenHealthy(t *testing.T) {
	state := &stubFallbackState{}
	var urls []string
	resp, err := postWithFallback(context.Background(), state, "kilo_code", "https://primary.test/chat/completions", "https://fallback.test/chat/completions", func(url string) (*http.Response, error) {
		urls = append(urls, url)
		return jsonTestResponse(http.StatusOK, `{}`), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if len(urls) != 1 || urls[0] != "https://primary.test/chat/completions" {
		t.Fatalf("urls = %#v", urls)
	}
	if len(state.calls) != 1 || state.calls[0] != "clear" {
		t.Fatalf("state calls = %#v", state.calls)
	}
}

func TestFallbackSwitchesOnForbidden(t *testing.T) {
	state := &stubFallbackState{}
	var urls []string
	resp, err := postWithFallback(context.Background(), state, "kilo_code", "https://primary.test/chat/completions", "https://fallback.test/chat/completions", func(url string) (*http.Response, error) {
		urls = append(urls, url)
		if strings.HasPrefix(url, "https://primary.test") {
			return jsonTestResponse(http.StatusForbidden, `{"error":{"message":"blocked"}}`), nil
		}
		return jsonTestResponse(http.StatusOK, `{}`), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if len(urls) != 2 || urls[0] != "https://primary.test/chat/completions" || urls[1] != "https://fallback.test/chat/completions" {
		t.Fatalf("urls = %#v", urls)
	}
	if len(state.calls) != 1 || state.calls[0] != "strike" {
		t.Fatalf("state calls = %#v", state.calls)
	}
}

func TestFallbackStaysOnPrimaryForOtherErrors(t *testing.T) {
	state := &stubFallbackState{}
	var urls []string
	resp, err := postWithFallback(context.Background(), state, "kilo_code", "https://primary.test/chat/completions", "https://fallback.test/chat/completions", func(url string) (*http.Response, error) {
		urls = append(urls, url)
		return jsonTestResponse(http.StatusBadRequest, `{"error":{"message":"bad"}}`), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if len(urls) != 1 || len(state.calls) != 0 {
		t.Fatalf("urls = %#v, state calls = %#v", urls, state.calls)
	}
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d", resp.StatusCode)
	}
}

func TestFallbackStickyGoesStraightToFallback(t *testing.T) {
	state := &stubFallbackState{stickyOn: true}
	var urls []string
	resp, err := postWithFallback(context.Background(), state, "kilo_code", "https://primary.test/chat/completions", "https://fallback.test/chat/completions", func(url string) (*http.Response, error) {
		urls = append(urls, url)
		return jsonTestResponse(http.StatusOK, `{}`), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if len(urls) != 1 || urls[0] != "https://fallback.test/chat/completions" {
		t.Fatalf("urls = %#v", urls)
	}
	if len(state.calls) != 0 {
		t.Fatalf("state calls = %#v", state.calls)
	}
}

func TestFallbackStickyRecoversToPrimary(t *testing.T) {
	state := &stubFallbackState{stickyOn: true}
	var urls []string
	resp, err := postWithFallback(context.Background(), state, "kilo_code", "https://primary.test/chat/completions", "https://fallback.test/chat/completions", func(url string) (*http.Response, error) {
		urls = append(urls, url)
		if strings.HasPrefix(url, "https://fallback.test") {
			return jsonTestResponse(http.StatusForbidden, `{"error":{"message":"blocked"}}`), nil
		}
		return jsonTestResponse(http.StatusOK, `{}`), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if len(urls) != 2 || urls[1] != "https://primary.test/chat/completions" {
		t.Fatalf("urls = %#v", urls)
	}
	if len(state.calls) != 1 || state.calls[0] != "clear" {
		t.Fatalf("state calls = %#v", state.calls)
	}
}

func TestFallbackWithoutFallbackURLSkipsRouter(t *testing.T) {
	state := &stubFallbackState{stickyOn: true}
	var urls []string
	resp, err := postWithFallback(context.Background(), state, "kilo_code", "https://primary.test/chat/completions", "", func(url string) (*http.Response, error) {
		urls = append(urls, url)
		return jsonTestResponse(http.StatusOK, `{}`), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if len(urls) != 1 || urls[0] != "https://primary.test/chat/completions" {
		t.Fatalf("urls = %#v", urls)
	}
	if len(state.calls) != 0 {
		t.Fatalf("state calls = %#v", state.calls)
	}
}

func TestFallbackRouterKeyFormat(t *testing.T) {
	if got := fallbackStickyKey("kilo_code"); got != "opendum:provider:fallback:kilo_code" {
		t.Fatalf("sticky key = %q", got)
	}
	if got := fallbackStrikeKey("kilo_code"); got != "opendum:provider:fallback-strikes:kilo_code" {
		t.Fatalf("strike key = %q", got)
	}
}

func TestFallbackRouterNilRedisIsInert(t *testing.T) {
	router := newFallbackRouter(nil)
	ctx := context.Background()
	if router.sticky(ctx, "kilo_code") {
		t.Fatal("sticky should be false without redis")
	}
	router.recordStrike(ctx, "kilo_code")
	router.clear(ctx, "kilo_code")
}

func TestFallbackClosesPrimaryBodyBeforeRetry(t *testing.T) {
	state := &stubFallbackState{}
	closed := false
	first := true
	resp, err := postWithFallback(context.Background(), state, "kilo_code", "https://primary.test/chat/completions", "https://fallback.test/chat/completions", func(string) (*http.Response, error) {
		if first {
			first = false
			return &http.Response{StatusCode: http.StatusForbidden, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: &trackingBody{closed: &closed}}, nil
		}
		return jsonTestResponse(http.StatusOK, `{}`), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if !closed {
		t.Fatal("primary response body was not closed")
	}
}

type trackingBody struct {
	closed *bool
}

func (b *trackingBody) Read([]byte) (int, error) { return 0, io.EOF }

func (b *trackingBody) Close() error {
	*b.closed = true
	return nil
}
