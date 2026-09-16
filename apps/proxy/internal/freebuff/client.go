package freebuff

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const defaultBaseURL = "https://www.codebuff.com"

const (
	sessionPath           = "/api/v1/freebuff/session"
	admissionPath         = "/api/v1/freebuff/session/admission"
	sessionRequestTimeout = 20 * time.Second
)

type Client struct {
	baseURL string
	http    *http.Client
}

func NewClient(baseURL string) *Client {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" {
		baseURL = defaultBaseURL
	}
	return &Client{
		baseURL: baseURL,
		http:    &http.Client{Transport: newTransport(), Timeout: 0},
	}
}

func (c *Client) StartRun(ctx context.Context, token, userID, agentID string) (string, error) {
	payload, err := json.Marshal(map[string]any{"action": "START", "agentId": agentID, "ancestorRunIds": []string{}})
	if err != nil {
		return "", err
	}
	req, err := c.newRequest(ctx, http.MethodPost, "/api/v1/agent-runs", payload, token, userID, false)
	if err != nil {
		return "", err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("start run failed with status %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var parsed struct {
		RunID string `json:"runId"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return "", fmt.Errorf("decode start run response: %w", err)
	}
	if strings.TrimSpace(parsed.RunID) == "" {
		return "", fmt.Errorf("start run response missing runId")
	}
	return parsed.RunID, nil
}

func (c *Client) FinishRun(ctx context.Context, token, userID, runID string, totalSteps int) error {
	payload, err := json.Marshal(map[string]any{
		"action":        "FINISH",
		"runId":         runID,
		"status":        "completed",
		"totalSteps":    totalSteps,
		"directCredits": 0,
		"totalCredits":  0,
		"steps":         []any{},
	})
	if err != nil {
		return err
	}
	req, err := c.newRequest(ctx, http.MethodPost, "/api/v1/agent-runs", payload, token, userID, false)
	if err != nil {
		return err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("finish run failed with status %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	return nil
}

func (c *Client) CreateOrRefreshSession(ctx context.Context, token, userID, model string) (freeSessionResponse, error) {
	return c.sessionRequest(ctx, http.MethodPost, token, userID, "", model)
}

func (c *Client) GetSession(ctx context.Context, token, userID, instanceID string) (freeSessionResponse, error) {
	return c.sessionRequest(ctx, http.MethodGet, token, userID, instanceID, "")
}

func (c *Client) EndSession(ctx context.Context, token, userID, instanceID string) error {
	ctx, cancel := context.WithTimeout(ctx, sessionRequestTimeout)
	defer cancel()
	req, err := c.newRequest(ctx, http.MethodDelete, sessionPath, nil, token, userID, false)
	if err != nil {
		return err
	}
	if id := strings.TrimSpace(instanceID); id != "" {
		req.Header.Set("x-freebuff-instance-id", id)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil
	}
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("free session delete failed with status %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var parsed struct {
		Status string `json:"status"`
	}
	if err := json.Unmarshal(body, &parsed); err == nil && strings.TrimSpace(parsed.Status) != "" {
		switch strings.TrimSpace(parsed.Status) {
		case "ended", "none":
			return nil
		}
		return fmt.Errorf("free session delete was not confirmed: %s", strings.TrimSpace(string(body)))
	}
	return nil
}

func (c *Client) Chat(ctx context.Context, token, userID string, body []byte) (*http.Response, []byte, error) {
	req, err := c.newRequest(ctx, http.MethodPost, "/api/v1/chat/completions", body, token, userID, true)
	if err != nil {
		return nil, nil, err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, nil, err
	}
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return resp, nil, nil
	}
	errorBody, readErr := io.ReadAll(resp.Body)
	resp.Body.Close()
	if readErr != nil {
		return nil, nil, readErr
	}
	return resp, errorBody, nil
}

func (c *Client) sessionRequest(ctx context.Context, method, token, userID, instanceID, model string) (freeSessionResponse, error) {
	ctx, cancel := context.WithTimeout(ctx, sessionRequestTimeout)
	defer cancel()

	path := sessionPath
	if method == http.MethodPost {
		path = admissionPath
	}
	resp, responseBody, err := c.doSession(ctx, method, path, token, userID, instanceID, model)
	if err != nil {
		return freeSessionResponse{}, err
	}
	if method == http.MethodPost && sessionPathUnsupported(resp.StatusCode) {
		resp, responseBody, err = c.doSession(ctx, method, sessionPath, token, userID, instanceID, model)
		if err != nil {
			return freeSessionResponse{}, err
		}
		if sessionPathUnsupported(resp.StatusCode) {
			return freeSessionResponse{}, &sessionRequestError{statusCode: resp.StatusCode, body: []byte("free session admission is not supported by this upstream")}
		}
	}
	return decodeSessionResponse(method, resp, responseBody)
}

func sessionPathUnsupported(statusCode int) bool {
	return statusCode == http.StatusNotFound || statusCode == http.StatusMethodNotAllowed
}

func (c *Client) doSession(ctx context.Context, method, path, token, userID, instanceID, model string) (*http.Response, []byte, error) {
	var body []byte
	if method == http.MethodPost {
		body = []byte("{}")
	}
	req, err := c.newRequest(ctx, method, path, body, token, userID, false)
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(token))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", ClientUserAgent())
	if method == http.MethodPost {
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("x-freebuff-wallet-spend-limit", "0")
		if strings.TrimSpace(model) != "" {
			req.Header.Set("x-freebuff-model", strings.TrimSpace(model))
		}
	}
	if method == http.MethodGet && instanceID != "" {
		req.Header.Set("x-freebuff-instance-id", instanceID)
		req.Header.Set("x-freebuff-compact-session", "1")
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer resp.Body.Close()
	responseBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, nil, err
	}
	return resp, responseBody, nil
}

func decodeSessionResponse(method string, resp *http.Response, responseBody []byte) (freeSessionResponse, error) {
	if resp.StatusCode == http.StatusNotFound {
		return freeSessionResponse{Status: string(statusNone)}, nil
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var parsed freeSessionResponse
		if json.Unmarshal(responseBody, &parsed) == nil && strings.TrimSpace(parsed.Status) != "" {
			switch resp.StatusCode {
			case http.StatusForbidden:
				if parsed.Status == string(statusCountryBlocked) || parsed.Status == string(statusBanned) {
					parsed.retryAfter = parseRetryAfter(resp.Header)
					return parsed, nil
				}
			case http.StatusConflict, http.StatusTooManyRequests:
				if method == http.MethodPost {
					switch sessionStatus(parsed.Status) {
					case statusModelLocked, statusModelUnavailable, statusRateLimited, statusSpendLimited, statusIPCapped, statusConsentRequired, statusSessionLimitReached:
						parsed.retryAfter = parseRetryAfter(resp.Header)
						return parsed, nil
					}
				}
			}
		}
		return freeSessionResponse{}, &sessionRequestError{statusCode: resp.StatusCode, retryAfter: parseRetryAfter(resp.Header), body: responseBody}
	}

	var parsed freeSessionResponse
	if err := json.Unmarshal(responseBody, &parsed); err != nil {
		return freeSessionResponse{}, err
	}
	parsed.retryAfter = parseRetryAfter(resp.Header)
	if strings.TrimSpace(parsed.Status) == "" {
		return freeSessionResponse{}, fmt.Errorf("free session response missing status")
	}
	return parsed, nil
}

func (c *Client) newRequest(ctx context.Context, method, path string, body []byte, token, userID string, chat bool) (*http.Request, error) {
	requestURL, err := url.JoinPath(c.baseURL, path)
	if err != nil {
		return nil, err
	}
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, requestURL, reader)
	if err != nil {
		return nil, err
	}
	setAuthHeaders(req, token, userID, chat)
	return req, nil
}
