package providers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
	"github.com/opendum/opendum/apps/proxy/internal/models"
)

const (
	clineAPIBase       = "https://api.cline.bot/api/v1"
	clineRefreshPath   = "/auth/refresh"
	clineChatPath      = "/chat/completions"
	clineAccessTTL     = time.Hour
	clineRefreshBuffer = 5 * time.Minute
)

var clineRequestHeaders = map[string]string{
	"HTTP-Referer":  "https://cline.bot",
	"X-Title":       "Pi",
	"X-CLIENT-TYPE": "cline-sdk",
}

var supportedCline = set("model", "messages", "temperature", "top_p", "max_tokens", "max_completion_tokens", "stream", "stream_options", "tools", "tool_choice", "parallel_tool_calls", "presence_penalty", "frequency_penalty", "n", "stop", "seed", "response_format", "reasoning", "reasoning_effort")

type clineProvider struct {
	registry *models.Registry
}

func (p clineProvider) RefreshBuffer() time.Duration { return clineRefreshBuffer }

func (p clineProvider) RefreshCredentials(ctx context.Context, client *http.Client, refreshToken string, _ appdb.ProviderAccount) (RefreshedCredentials, error) {
	payload, _ := json.Marshal(map[string]string{"refreshToken": strings.TrimSpace(refreshToken), "grantType": "refresh_token"})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, clineAPIBase+clineRefreshPath, bytes.NewReader(payload))
	if err != nil {
		return RefreshedCredentials{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return RefreshedCredentials{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body := readLimit(resp.Body, 1<<20)
		return RefreshedCredentials{}, fmt.Errorf("cline token refresh failed: %d %s", resp.StatusCode, body)
	}
	var token struct {
		Data struct {
			AccessToken  string `json:"accessToken"`
			RefreshToken string `json:"refreshToken"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&token); err != nil {
		return RefreshedCredentials{}, err
	}
	if strings.TrimSpace(token.Data.AccessToken) == "" {
		return RefreshedCredentials{}, fmt.Errorf("cline token refresh returned empty access token")
	}
	if token.Data.RefreshToken == "" {
		token.Data.RefreshToken = refreshToken
	}
	return RefreshedCredentials{AccessToken: "workos:" + token.Data.AccessToken, RefreshToken: token.Data.RefreshToken, ExpiresAt: time.Now().Add(clineAccessTTL)}, nil
}

func (p clineProvider) MakeRequest(ctx context.Context, client *http.Client, credentials string, _ appdb.ProviderAccount, body map[string]any, stream bool) (*http.Response, error) {
	payload := map[string]any{}
	for key, value := range body {
		if _, ok := supportedCline[key]; ok && value != nil {
			payload[key] = value
		}
	}
	model := stringValue(body["model"])
	if strings.HasPrefix(model, "cline/") {
		model = strings.TrimPrefix(model, "cline/")
	}
	if p.registry != nil {
		model = p.registry.UpstreamModelName(model, "cline")
	}
	payload["model"] = model
	payload["stream"] = stream
	return postJSONWithHeaders(ctx, client, clineAPIBase+clineChatPath, credentials, payload, stream, clineRequestHeaders)
}