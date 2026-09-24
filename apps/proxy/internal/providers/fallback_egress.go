package providers

import (
	"context"
	"log/slog"
	"net"
	"net/http"
)

type Egress interface {
	DialContext(ctx context.Context, network string, addr string) (net.Conn, error)
	Ready() bool
	Rotate(ctx context.Context)
}

// RegionDialer is an Egress that can dial through a specific egress country.
// Providers that upstream only serves from one region (freebuff is US-only)
// require it so their traffic cannot leak out of a different exit.
type RegionDialer interface {
	DialRegion(ctx context.Context, network string, addr string, region string) (net.Conn, error)
}

// FreebuffRegion is the only region the freebuff upstream serves. Providers
// and quota pollers that talk to freebuff must egress from here so their
// traffic cannot leak out of a different exit.
const FreebuffRegion = "US"

const (
	egressMaxTries       = 3
	egressForbiddenTries = 2
)

func egressReady(egress Egress, egressClient *http.Client) bool {
	return egress != nil && egressClient != nil && egress.Ready()
}

func postWithEgressFallback(ctx context.Context, state fallbackState, provider string, primary string, directClient *http.Client, egressClient *http.Client, egress Egress, do func(client *http.Client, url string) (*http.Response, error)) (*http.Response, error) {
	if state == nil {
		state = noFallbackState{}
	}
	if !egressReady(egress, egressClient) || directClient == nil {
		if directClient == nil {
			directClient = egressClient
		}
		if directClient == nil {
			return do(directClient, primary)
		}
		return postPrimaryWithClient(ctx, state, provider, primary, directClient, do)
	}
	if state.sticky(ctx, provider) {
		slog.Info("egress preferred", "provider", provider)
		resp, err := postEgressWithRotation(ctx, provider, primary, egressClient, egress, do)
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
	slog.Info("egress fallback", "provider", provider, "status", resp.StatusCode)
	_ = resp.Body.Close()
	state.recordStrike(ctx, provider)
	return postEgressWithRotation(ctx, provider, primary, egressClient, egress, do)
}

// postEgressWithRotation retries through the egress, rotating to a fresh
// tunnel/IP on 429 or transport failure (bounded) and on 403 (once).
func postEgressWithRotation(ctx context.Context, provider string, primary string, egressClient *http.Client, egress Egress, do func(client *http.Client, url string) (*http.Response, error)) (*http.Response, error) {
	for attempt := 0; ; attempt++ {
		resp, err := do(egressClient, primary)
		if err == nil && resp != nil && !shouldUseFallbackEndpoint(resp.StatusCode) {
			return resp, nil
		}
		maxTries := egressMaxTries
		if resp != nil && resp.StatusCode == http.StatusForbidden {
			maxTries = egressForbiddenTries
		}
		if attempt+1 >= maxTries {
			return resp, err
		}
		if resp != nil {
			_ = resp.Body.Close()
		}
		slog.Warn("egress rotate", "provider", provider, "attempt", attempt+1, "status", statusOf(resp), "error", err)
		egressClient.CloseIdleConnections()
		if egress != nil {
			egress.Rotate(ctx)
		}
	}
}

func postPrimaryWithClient(ctx context.Context, state fallbackState, provider string, primary string, client *http.Client, do func(client *http.Client, url string) (*http.Response, error)) (*http.Response, error) {
	resp, err := do(client, primary)
	if err == nil && resp != nil && resp.StatusCode >= 200 && resp.StatusCode < 300 {
		state.clear(ctx, provider)
	}
	return resp, err
}

func postJSONWithEgressFallback(ctx context.Context, directClient *http.Client, egressClient *http.Client, egress Egress, state fallbackState, provider string, primaryURL string, bearer string, payload map[string]any, stream bool, headers map[string]string) (*http.Response, error) {
	return postWithEgressFallback(ctx, state, provider, primaryURL, directClient, egressClient, egress, func(client *http.Client, target string) (*http.Response, error) {
		return postJSONWithHeaders(ctx, client, target, bearer, payload, stream, headers)
	})
}

func statusOf(resp *http.Response) int {
	if resp == nil {
		return 0
	}
	return resp.StatusCode
}
