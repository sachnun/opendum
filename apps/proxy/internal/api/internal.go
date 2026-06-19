package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const internalRelayMaxBodyBytes = 2 << 20

var internalRelayClient = &http.Client{Timeout: 20 * time.Second}

type internalRelayRequest struct {
	URL     string            `json:"url"`
	Method  string            `json:"method,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
	Body    json.RawMessage   `json:"body,omitempty"`
}

var internalRelayAllowedHosts = map[string]struct{}{
	"api.cloudflare.com":    {},
	"api.github.com":        {},
	"api.githubcopilot.com": {},
	"api.kilo.ai":           {},
	"api.siliconflow.com":   {},
	"auth.openai.com":       {},
	"autopush-cloudcode-pa.sandbox.googleapis.com": {},
	"chatgpt.com":                               {},
	"cloudcode-pa.googleapis.com":               {},
	"cloudresourcemanager.googleapis.com":       {},
	"daily-cloudcode-pa.googleapis.com":         {},
	"daily-cloudcode-pa.sandbox.googleapis.com": {},
	"github.com":                                {},
	"integrate.api.nvidia.com":                  {},
	"oauth2.googleapis.com":                     {},
	"openapi.qoder.sh":                          {},
	"openrouter.ai":                             {},
	"prod.us-east-1.auth.desktop.kiro.dev":      {},
	"q.us-east-1.amazonaws.com":                 {},
	"www.googleapis.com":                        {},
	"zenmux.ai":                                 {},
}

func (s *Server) internalRefreshRoute(w http.ResponseWriter, r *http.Request) {
	rawBody, err := io.ReadAll(http.MaxBytesReader(w, r.Body, internalRelayMaxBodyBytes))
	if err != nil {
		writeInternalRelayError(w, http.StatusBadRequest, "Invalid internal refresh payload")
		return
	}
	if !s.validateInternalSignature(r, "/internal/refresh", rawBody) {
		writeInternalRelayError(w, http.StatusUnauthorized, "Invalid internal refresh signature")
		return
	}
	s.internalRefreshRouteWithBody(w, r, rawBody)
}

func (s *Server) internalRefreshRouteWithBody(w http.ResponseWriter, r *http.Request, rawBody []byte) {
	var input internalRelayRequest
	decoder := json.NewDecoder(bytes.NewReader(rawBody))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		writeInternalRelayError(w, http.StatusBadRequest, "Invalid internal refresh payload")
		return
	}

	input.URL = strings.TrimSpace(input.URL)
	if input.URL == "" {
		writeInternalRelayError(w, http.StatusBadRequest, "url is required")
		return
	}

	method, upstreamURL, err := resolveInternalRelayTarget(input)
	if err != nil {
		writeInternalRelayError(w, http.StatusBadRequest, err.Error())
		return
	}
	body, err := internalRelayBody(input.Body)
	if err != nil {
		writeInternalRelayError(w, http.StatusBadRequest, err.Error())
		return
	}

	var bodyReader io.Reader
	if body != nil {
		bodyReader = bytes.NewReader(body)
	}
	upstreamReq, err := http.NewRequestWithContext(r.Context(), method, upstreamURL, bodyReader)
	if err != nil {
		writeInternalRelayError(w, http.StatusBadRequest, "Invalid internal relay upstream")
		return
	}
	copyInternalRelayHeaders(upstreamReq.Header, input.Headers)

	resp, err := internalRelayClient.Do(upstreamReq)
	if err != nil {
		writeInternalRelayError(w, http.StatusBadGateway, fmt.Sprintf("Internal relay upstream request failed: %s", err.Error()))
		return
	}
	defer resp.Body.Close()

	copyInternalRelayResponseHeaders(w.Header(), resp.Header)
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

func resolveInternalRelayTarget(input internalRelayRequest) (string, string, error) {
	method := strings.ToUpper(strings.TrimSpace(input.Method))
	if method == "" {
		method = http.MethodGet
	}
	if err := validateInternalRelayMethod(method); err != nil {
		return "", "", err
	}
	target, err := url.Parse(input.URL)
	if err != nil {
		return "", "", errors.New("url is invalid")
	}
	if target.Scheme != "https" || target.Hostname() == "" || target.User != nil {
		return "", "", errors.New("url must be an https provider URL")
	}
	if _, ok := internalRelayAllowedHosts[strings.ToLower(target.Hostname())]; !ok {
		return "", "", errors.New("url host is not allowed")
	}
	return method, target.String(), nil
}

func validateInternalRelayMethod(method string) error {
	switch method {
	case http.MethodGet, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		return nil
	default:
		return fmt.Errorf("Unsupported internal relay method: %s", method)
	}
}

func internalRelayBody(raw json.RawMessage) ([]byte, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil, nil
	}
	if trimmed[0] != '"' {
		return trimmed, nil
	}

	var value string
	if err := json.Unmarshal(trimmed, &value); err != nil {
		return nil, errors.New("body string is invalid")
	}
	return []byte(value), nil
}

func copyInternalRelayHeaders(dst http.Header, src map[string]string) {
	for key, value := range src {
		normalized := strings.ToLower(strings.TrimSpace(key))
		if isBlockedInternalRelayHeader(normalized) || strings.TrimSpace(value) == "" {
			continue
		}
		dst.Set(http.CanonicalHeaderKey(normalized), value)
	}
}

func isBlockedInternalRelayHeader(header string) bool {
	if header == "" || strings.HasPrefix(header, ":") || strings.HasPrefix(header, "proxy-") {
		return true
	}
	switch header {
	case "host", "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "content-length", "accept-encoding", "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip":
		return true
	default:
		return false
	}
}

func writeInternalRelayError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("X-Opendum-Internal-Relay-Error", "1")
	writeJSON(w, status, map[string]any{"error": message})
}

func copyInternalRelayResponseHeaders(dst, src http.Header) {
	for header, values := range src {
		if isBlockedInternalRelayResponseHeader(strings.ToLower(header)) {
			continue
		}
		for _, value := range values {
			dst.Add(header, value)
		}
	}
}

func isBlockedInternalRelayResponseHeader(header string) bool {
	if header == "" || strings.HasPrefix(header, "proxy-") {
		return true
	}
	switch header {
	case "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "content-length", "set-cookie":
		return true
	default:
		return false
	}
}
