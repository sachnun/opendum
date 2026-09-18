package providers

import (
	"context"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
)

type stubEgress struct {
	ready bool
	dial  func(ctx context.Context, network string, addr string) (net.Conn, error)
}

func (s *stubEgress) Ready() bool { return s.ready }

func (s *stubEgress) DialContext(ctx context.Context, network string, addr string) (net.Conn, error) {
	if s.dial != nil {
		return s.dial(ctx, network, addr)
	}
	return nil, context.Canceled
}

func egressTestResponse(status int) *http.Response {
	return &http.Response{
		StatusCode: status,
		Header:     http.Header{},
		Body:       io.NopCloser(strings.NewReader(`{}`)),
	}
}

func TestEgressFallbackUsesPrimaryWhenHealthy(t *testing.T) {
	state := &stubFallbackState{}
	direct := &http.Client{}
	egressClient := &http.Client{}
	egress := &stubEgress{ready: true}
	var got []string
	resp, err := postWithEgressFallback(context.Background(), state, "opencode", "https://primary.test/v1", direct, egressClient, egress, func(c *http.Client, url string) (*http.Response, error) {
		if c == egressClient {
			got = append(got, "egress:"+url)
		} else {
			got = append(got, "direct:"+url)
		}
		return egressTestResponse(http.StatusOK), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if len(got) != 1 || got[0] != "direct:https://primary.test/v1" {
		t.Fatalf("got = %#v", got)
	}
}

func TestEgressFallbackSwitchesOnForbidden(t *testing.T) {
	state := &stubFallbackState{}
	direct := &http.Client{}
	egressClient := &http.Client{}
	egress := &stubEgress{ready: true}
	var got []string
	resp, err := postWithEgressFallback(context.Background(), state, "opencode", "https://primary.test/v1", direct, egressClient, egress, func(c *http.Client, url string) (*http.Response, error) {
		if c == egressClient {
			got = append(got, "egress")
			return egressTestResponse(http.StatusOK), nil
		}
		got = append(got, "direct")
		return egressTestResponse(http.StatusForbidden), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if len(got) != 2 || got[0] != "direct" || got[1] != "egress" {
		t.Fatalf("got = %#v", got)
	}
	if len(state.calls) != 1 || state.calls[0] != "strike" {
		t.Fatalf("state calls = %#v", state.calls)
	}
}

func TestEgressFallbackSwitchesOnTooManyRequests(t *testing.T) {
	state := &stubFallbackState{}
	direct := &http.Client{}
	egressClient := &http.Client{}
	egress := &stubEgress{ready: true}
	calls := 0
	resp, err := postWithEgressFallback(context.Background(), state, "kilo_code", "https://primary.test/v1", direct, egressClient, egress, func(c *http.Client, url string) (*http.Response, error) {
		calls++
		if c == egressClient {
			return egressTestResponse(http.StatusOK), nil
		}
		return egressTestResponse(http.StatusTooManyRequests), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if calls != 2 {
		t.Fatalf("calls = %d", calls)
	}
}

func TestEgressFallbackStaysDirectForBadRequest(t *testing.T) {
	state := &stubFallbackState{}
	direct := &http.Client{}
	egressClient := &http.Client{}
	egress := &stubEgress{ready: true}
	calls := 0
	resp, err := postWithEgressFallback(context.Background(), state, "opencode", "https://primary.test/v1", direct, egressClient, egress, func(c *http.Client, url string) (*http.Response, error) {
		calls++
		return egressTestResponse(http.StatusBadRequest), nil
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

func TestEgressFallbackDirectOnlyWhenNotReady(t *testing.T) {
	state := &stubFallbackState{}
	direct := &http.Client{}
	egressClient := &http.Client{}
	egress := &stubEgress{ready: false}
	calls := 0
	resp, err := postWithEgressFallback(context.Background(), state, "opencode", "https://primary.test/v1", direct, egressClient, egress, func(c *http.Client, url string) (*http.Response, error) {
		calls++
		return egressTestResponse(http.StatusForbidden), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if calls != 1 {
		t.Fatalf("calls = %d", calls)
	}
}

func TestEgressFallbackStickyPrefersEgress(t *testing.T) {
	state := &stubFallbackState{stickyOn: true}
	direct := &http.Client{}
	egressClient := &http.Client{}
	egress := &stubEgress{ready: true}
	var got []string
	resp, err := postWithEgressFallback(context.Background(), state, "opencode", "https://primary.test/v1", direct, egressClient, egress, func(c *http.Client, url string) (*http.Response, error) {
		if c == egressClient {
			got = append(got, "egress")
		} else {
			got = append(got, "direct")
		}
		return egressTestResponse(http.StatusOK), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if len(got) != 1 || got[0] != "egress" {
		t.Fatalf("got = %#v", got)
	}
}

func TestRegistrySetEgressPropagates(t *testing.T) {
	r := NewRegistry(nil, nil, nil)
	egress := &stubEgress{ready: true}
	egressClient := &http.Client{}
	r.SetEgress(egress, egressClient)
	if !r.EgressReady() {
		t.Fatal("registry should be egress ready")
	}
	got, ok := r.Get("opencode")
	if !ok {
		t.Fatal("missing opencode provider")
	}
	typed, ok := got.(opencodeProvider)
	if !ok {
		t.Fatalf("unexpected type %T", got)
	}
	if !egressReady(typed.egress, typed.egressClient) {
		t.Fatal("opencode provider should carry egress")
	}
	kilo, ok := r.Get("kilo_code")
	if !ok {
		t.Fatal("missing kilo_code provider")
	}
	kiloTyped, ok := kilo.(openAICompatibleProvider)
	if !ok {
		t.Fatalf("unexpected type %T", kilo)
	}
	if !egressReady(kiloTyped.egress, kiloTyped.egressClient) {
		t.Fatal("kilo_code provider should carry egress")
	}
}
