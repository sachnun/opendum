package providers

import (
	"context"
	"net"
	"net/http"
	"time"
)

type TorEgress interface {
	DialContext(ctx context.Context, network string, addr string) (net.Conn, error)
	Ready() bool
}

func NewTorClient(dial func(ctx context.Context, network string, addr string) (net.Conn, error)) *http.Client {
	return &http.Client{
		Timeout: 0,
		Transport: &http.Transport{
			DialContext:           dial,
			ForceAttemptHTTP2:     false,
			MaxIdleConns:          10,
			IdleConnTimeout:       90 * time.Second,
			TLSHandshakeTimeout:   15 * time.Second,
			ResponseHeaderTimeout: 60 * time.Second,
		},
	}
}

func torReady(tor TorEgress, torClient *http.Client) bool {
	return tor != nil && torClient != nil && tor.Ready()
}

func postWithTorFallback(ctx context.Context, state fallbackState, provider string, primary string, directClient *http.Client, torClient *http.Client, tor TorEgress, do func(client *http.Client, url string) (*http.Response, error)) (*http.Response, error) {
	if state == nil {
		state = noFallbackState{}
	}
	if !torReady(tor, torClient) || directClient == nil {
		if directClient == nil {
			directClient = torClient
		}
		if directClient == nil {
			return do(directClient, primary)
		}
		return postPrimaryWithClient(ctx, state, provider, primary, directClient, do)
	}
	if state.sticky(ctx, provider) {
		resp, err := do(torClient, primary)
		if err != nil || resp == nil || !shouldUseFallbackEndpoint(resp.StatusCode) {
			return resp, err
		}
		_ = resp.Body.Close()
		return postPrimaryWithClient(ctx, state, provider, primary, directClient, do)
	}
	resp, err := postPrimaryWithClient(ctx, state, provider, primary, directClient, do)
	if err != nil || resp == nil || !shouldUseFallbackEndpoint(resp.StatusCode) {
		return resp, err
	}
	_ = resp.Body.Close()
	state.recordStrike(ctx, provider)
	return do(torClient, primary)
}

func postPrimaryWithClient(ctx context.Context, state fallbackState, provider string, primary string, client *http.Client, do func(client *http.Client, url string) (*http.Response, error)) (*http.Response, error) {
	resp, err := do(client, primary)
	if err == nil && resp != nil && resp.StatusCode >= 200 && resp.StatusCode < 300 {
		state.clear(ctx, provider)
	}
	return resp, err
}

func postJSONWithTorFallback(ctx context.Context, directClient *http.Client, torClient *http.Client, tor TorEgress, state fallbackState, provider string, primaryURL string, bearer string, payload map[string]any, stream bool, headers map[string]string) (*http.Response, error) {
	return postWithTorFallback(ctx, state, provider, primaryURL, directClient, torClient, tor, func(client *http.Client, target string) (*http.Response, error) {
		return postJSONWithHeaders(ctx, client, target, bearer, payload, stream, headers)
	})
}

func postJSONWithoutAuthWithTorFallback(ctx context.Context, directClient *http.Client, torClient *http.Client, tor TorEgress, state fallbackState, provider string, primaryURL string, payload map[string]any, stream bool) (*http.Response, error) {
	return postWithTorFallback(ctx, state, provider, primaryURL, directClient, torClient, tor, func(client *http.Client, target string) (*http.Response, error) {
		return postJSONWithoutAuth(ctx, client, target, payload, stream)
	})
}
