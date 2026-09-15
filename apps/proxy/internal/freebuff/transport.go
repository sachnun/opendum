package freebuff

import (
	"context"
	cryptoTLS "crypto/tls"
	"net"
	"net/http"
	"strings"

	tls "github.com/refraction-networking/utls"
	"golang.org/x/net/http2"
)

const (
	actingUserIDHeader = "x-freebuff-acting-user-id"
	clientUserAgent    = "Freebuff-CLI/dev"
	chatUserAgent      = "ai-sdk/openai-compatible/3.0.25/codebuff"
)

func newTransport() http.RoundTripper {
	return &protoDispatchTransport{h1: newH1Transport(), h2: newH2Transport()}
}

type protoDispatchTransport struct {
	h1 http.RoundTripper
	h2 http.RoundTripper
}

func (d *protoDispatchTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.URL == nil || req.URL.Scheme != "https" {
		return d.h1.RoundTrip(req)
	}
	resp, err := d.h2.RoundTrip(req)
	if err == nil {
		return resp, nil
	}
	if retryableH2Request(req, err) {
		return d.h1.RoundTrip(req)
	}
	return nil, err
}

func retryableH2Request(req *http.Request, err error) bool {
	if err == nil {
		return false
	}
	message := err.Error()
	if strings.Contains(message, "http2:") || strings.Contains(message, "H2") || strings.Contains(message, "client preface") {
		return true
	}
	switch req.Method {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return true
	default:
		return false
	}
}

func newH2Transport() http.RoundTripper {
	return &http2.Transport{DialTLSContext: utlsDialTLS}
}

func newH1Transport() *http.Transport {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.Proxy = nil
	tr.DialContext = nil
	tr.DialTLSContext = utlsDialTLSH1
	tr.ForceAttemptHTTP2 = false
	return tr
}

func utlsDialTLSH1(ctx context.Context, network, addr string) (net.Conn, error) {
	return utlsDialConn(ctx, network, addr, nil)
}

func utlsDialTLS(ctx context.Context, network, addr string, cfg *cryptoTLS.Config) (net.Conn, error) {
	return utlsDialConn(ctx, network, addr, cfg)
}

func utlsDialConn(ctx context.Context, network, addr string, opt *cryptoTLS.Config) (net.Conn, error) {
	conn, err := (&net.Dialer{}).DialContext(ctx, network, addr)
	if err != nil {
		return nil, err
	}
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		conn.Close()
		return nil, err
	}
	spec, err := tls.UTLSIdToSpec(tls.HelloChrome_133)
	if err != nil {
		conn.Close()
		return nil, err
	}
	cfg := &tls.Config{ServerName: host}
	if opt != nil {
		if opt.ServerName != "" {
			cfg.ServerName = opt.ServerName
		}
		cfg.InsecureSkipVerify = opt.InsecureSkipVerify
		cfg.RootCAs = opt.RootCAs
	}
	tlsConn := tls.UClient(conn, cfg, tls.HelloCustom)
	if err := tlsConn.ApplyPreset(&spec); err != nil {
		conn.Close()
		return nil, err
	}
	if err := tlsConn.HandshakeContext(ctx); err != nil {
		conn.Close()
		return nil, err
	}
	return tlsConn, nil
}

func setAuthHeaders(req *http.Request, token, userID string, chat bool) {
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(token))
	if chat {
		req.Header.Set("User-Agent", chatUserAgent)
		req.Header.Set("Content-Type", "application/json")
	} else {
		req.Header.Set("User-Agent", clientUserAgent)
		req.Header.Set("Accept", "application/json, text/plain, */*")
		req.Header.Set("Accept-Language", "en-US,en;q=0.9")
		req.Header.Set("Cache-Control", "no-cache")
	}
	if id := strings.TrimSpace(userID); id != "" {
		req.Header.Set(actingUserIDHeader, id)
	}
}
