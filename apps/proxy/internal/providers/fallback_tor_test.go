package providers

import (
	"context"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
)

type stubTor struct {
	ready bool
	dial  func(ctx context.Context, network string, addr string) (net.Conn, error)
}

func (s *stubTor) Ready() bool { return s.ready }

func (s *stubTor) DialContext(ctx context.Context, network string, addr string) (net.Conn, error) {
	if s.dial != nil {
		return s.dial(ctx, network, addr)
	}
	return nil, context.Canceled
}

func torTestResponse(status int) *http.Response {
	return &http.Response{
		StatusCode: status,
		Header:     http.Header{},
		Body:       io.NopCloser(strings.NewReader(`{}`)),
	}
}

func TestTorFallbackUsesPrimaryWhenHealthy(t *testing.T) {
	state := &stubFallbackState{}
	direct := &http.Client{}
	torClient := &http.Client{}
	tor := &stubTor{ready: true}
	var got []string
	resp, err := postWithTorFallback(context.Background(), state, "opencode", "https://primary.test/v1", direct, torClient, tor, func(c *http.Client, url string) (*http.Response, error) {
		if c == torClient {
			got = append(got, "tor:"+url)
		} else {
			got = append(got, "direct:"+url)
		}
		return torTestResponse(http.StatusOK), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if len(got) != 1 || got[0] != "direct:https://primary.test/v1" {
		t.Fatalf("got = %#v", got)
	}
}

func TestTorFallbackSwitchesOnForbidden(t *testing.T) {
	state := &stubFallbackState{}
	direct := &http.Client{}
	torClient := &http.Client{}
	tor := &stubTor{ready: true}
	var got []string
	resp, err := postWithTorFallback(context.Background(), state, "opencode", "https://primary.test/v1", direct, torClient, tor, func(c *http.Client, url string) (*http.Response, error) {
		if c == torClient {
			got = append(got, "tor")
			return torTestResponse(http.StatusOK), nil
		}
		got = append(got, "direct")
		return torTestResponse(http.StatusForbidden), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if len(got) != 2 || got[0] != "direct" || got[1] != "tor" {
		t.Fatalf("got = %#v", got)
	}
	if len(state.calls) != 1 || state.calls[0] != "strike" {
		t.Fatalf("state calls = %#v", state.calls)
	}
}

func TestTorFallbackSwitchesOnTooManyRequests(t *testing.T) {
	state := &stubFallbackState{}
	direct := &http.Client{}
	torClient := &http.Client{}
	tor := &stubTor{ready: true}
	calls := 0
	resp, err := postWithTorFallback(context.Background(), state, "kilo_code", "https://primary.test/v1", direct, torClient, tor, func(c *http.Client, url string) (*http.Response, error) {
		calls++
		if c == torClient {
			return torTestResponse(http.StatusOK), nil
		}
		return torTestResponse(http.StatusTooManyRequests), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if calls != 2 {
		t.Fatalf("calls = %d", calls)
	}
}

func TestTorFallbackStaysDirectForBadRequest(t *testing.T) {
	state := &stubFallbackState{}
	direct := &http.Client{}
	torClient := &http.Client{}
	tor := &stubTor{ready: true}
	calls := 0
	resp, err := postWithTorFallback(context.Background(), state, "opencode", "https://primary.test/v1", direct, torClient, tor, func(c *http.Client, url string) (*http.Response, error) {
		calls++
		return torTestResponse(http.StatusBadRequest), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if calls != 1 {
		t.Fatalf("calls = %d", calls)
	}
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d", resp.StatusCode)
	}
}

func TestTorFallbackDirectOnlyWhenNotReady(t *testing.T) {
	state := &stubFallbackState{}
	direct := &http.Client{}
	torClient := &http.Client{}
	tor := &stubTor{ready: false}
	calls := 0
	resp, err := postWithTorFallback(context.Background(), state, "opencode", "https://primary.test/v1", direct, torClient, tor, func(c *http.Client, url string) (*http.Response, error) {
		calls++
		return torTestResponse(http.StatusForbidden), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if calls != 1 {
		t.Fatalf("calls = %d", calls)
	}
}

func TestTorFallbackStickyPrefersTor(t *testing.T) {
	state := &stubFallbackState{stickyOn: true}
	direct := &http.Client{}
	torClient := &http.Client{}
	tor := &stubTor{ready: true}
	var got []string
	resp, err := postWithTorFallback(context.Background(), state, "opencode", "https://primary.test/v1", direct, torClient, tor, func(c *http.Client, url string) (*http.Response, error) {
		if c == torClient {
			got = append(got, "tor")
		} else {
			got = append(got, "direct")
		}
		return torTestResponse(http.StatusOK), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if len(got) != 1 || got[0] != "tor" {
		t.Fatalf("got = %#v", got)
	}
}

func TestRegistrySetTorEgressPropagates(t *testing.T) {
	r := NewRegistry(nil, nil, nil)
	tor := &stubTor{ready: true}
	torClient := &http.Client{}
	r.SetTorEgress(tor, torClient)
	if !r.TorReady() {
		t.Fatal("registry should be tor ready")
	}
	got, ok := r.Get("opencode")
	if !ok {
		t.Fatal("missing opencode provider")
	}
	typed, ok := got.(opencodeProvider)
	if !ok {
		t.Fatalf("unexpected type %T", got)
	}
	if !torReady(typed.tor, typed.torClient) {
		t.Fatal("opencode provider should carry tor egress")
	}
	kilo, ok := r.Get("kilo_code")
	if !ok {
		t.Fatal("missing kilo_code provider")
	}
	kiloTyped, ok := kilo.(openAICompatibleProvider)
	if !ok {
		t.Fatalf("unexpected type %T", kilo)
	}
	if !torReady(kiloTyped.tor, kiloTyped.torClient) {
		t.Fatal("kilo_code provider should carry tor egress")
	}
}
