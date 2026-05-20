package providers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
	"github.com/opendum/opendum/apps/proxy/internal/models"
)

const (
	copilotClientID              = "Ov23li8tweQw6odWQebz"
	copilotTokenEndpoint         = "https://github.com/login/oauth/access_token"
	copilotInternalTokenEndpoint = "https://api.github.com/copilot_internal/v2/token"
	copilotAPIBaseURL            = "https://api.githubcopilot.com"
	copilotUserEndpoint          = "https://api.github.com/user"
	copilotUserAgent             = "opencode/1.1.65"
	copilotIntent                = "conversation-edits"
	copilotSystemToolKey         = "opendum:copilot:system-tool-window"
)

type copilotProvider struct {
	registry *models.Registry
	redis    *redis.Client
}

func (p copilotProvider) RefreshBuffer() time.Duration { return 5 * time.Minute }

func (p copilotProvider) RefreshCredentials(ctx context.Context, client *http.Client, refreshToken string, _ appdb.ProviderAccount) (RefreshedCredentials, error) {
	refreshToken = strings.TrimSpace(refreshToken)
	if refreshToken != "" && !strings.HasPrefix(refreshToken, "ghr_") {
		return refreshCopilotFromGitHubToken(ctx, client, refreshToken)
	}

	payload, _ := json.Marshal(map[string]any{"client_id": copilotClientID, "grant_type": "refresh_token", "refresh_token": strings.TrimSpace(refreshToken)})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, copilotTokenEndpoint, bytes.NewReader(payload))
	if err != nil {
		return RefreshedCredentials{}, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", copilotUserAgent)
	resp, err := client.Do(req)
	if err != nil {
		return RefreshedCredentials{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body := readLimit(resp.Body, 1<<20)
		return RefreshedCredentials{}, fmt.Errorf("copilot token refresh failed: %d %s", resp.StatusCode, body)
	}
	var token struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int64  `json:"expires_in"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&token); err != nil {
		return RefreshedCredentials{}, err
	}
	if token.AccessToken == "" {
		return RefreshedCredentials{}, fmt.Errorf("copilot token refresh returned empty access token")
	}
	refreshed, err := refreshCopilotFromGitHubToken(ctx, client, token.AccessToken)
	if err != nil {
		return RefreshedCredentials{}, err
	}
	if token.RefreshToken != "" {
		refreshed.RefreshToken = token.RefreshToken
	} else {
		refreshed.RefreshToken = refreshToken
	}
	return refreshed, nil
}

func refreshCopilotFromGitHubToken(ctx context.Context, client *http.Client, githubToken string) (RefreshedCredentials, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, copilotInternalTokenEndpoint, nil)
	if err != nil {
		return RefreshedCredentials{}, err
	}
	req.Header.Set("Authorization", "Token "+strings.TrimSpace(githubToken))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", copilotUserAgent)
	resp, err := client.Do(req)
	if err != nil {
		return RefreshedCredentials{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body := readLimit(resp.Body, 1<<20)
		return RefreshedCredentials{}, fmt.Errorf("copilot token exchange failed: %d %s", resp.StatusCode, body)
	}
	var token struct {
		Token     string `json:"token"`
		ExpiresAt int64  `json:"expires_at"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&token); err != nil {
		return RefreshedCredentials{}, err
	}
	if token.Token == "" {
		return RefreshedCredentials{}, fmt.Errorf("copilot token exchange returned empty token")
	}
	expiresAt := time.Now().Add(time.Hour)
	if token.ExpiresAt > 0 {
		expiresAt = time.Unix(token.ExpiresAt, 0)
	}
	tier := fetchCopilotTier(ctx, client, githubToken)
	return RefreshedCredentials{AccessToken: token.Token, RefreshToken: githubToken, StoreAccessToken: token.Token, ExpiresAt: expiresAt, Email: fetchCopilotIdentity(ctx, client, githubToken), Tier: tier}, nil
}

func fetchCopilotTier(ctx context.Context, client *http.Client, accessToken string) string {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.github.com/copilot_internal/user", nil)
	if err != nil {
		return ""
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(accessToken))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "GitHubCopilotChat/0.26.7")
	req.Header.Set("Editor-Version", "vscode/1.96.2")
	req.Header.Set("Editor-Plugin-Version", "copilot-chat/0.26.7")
	req.Header.Set("X-GitHub-Api-Version", "2025-04-01")
	resp, err := client.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return ""
	}
	var payload map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return ""
	}
	return normalizeCopilotTier(payload)
}

func normalizeCopilotTier(payload map[string]any) string {
	for _, raw := range []string{copilotString(payload["access_type_sku"]), copilotString(payload["copilot_plan"])} {
		value := normalizeCopilotTierValue(raw)
		if value == "" {
			continue
		}
		if strings.Contains(value, "education") || strings.Contains(value, "student") {
			return "student"
		}
		if strings.Contains(value, "free") {
			return "free"
		}
		if strings.Contains(value, "enterprise") {
			return "enterprise"
		}
		if strings.Contains(value, "business") {
			return "business"
		}
		if value == "pro-plus" || value == "proplus" || value == "pro+" {
			return "pro+"
		}
		if value == "pro" || strings.Contains(value, "-pro-") {
			return "pro"
		}
	}

	snapshots, _ := payload["quota_snapshots"].(map[string]any)
	premium, _ := snapshots["premium_interactions"].(map[string]any)
	switch copilotNumber(premium["entitlement"]) {
	case 50:
		return "free"
	case 300:
		return "pro"
	case 1000:
		return "enterprise"
	case 1500:
		return "pro+"
	}
	return ""
}

func normalizeCopilotTierValue(value string) string {
	return strings.ToLower(strings.ReplaceAll(strings.TrimSpace(value), "_", "-"))
}

func copilotString(value any) string {
	str, _ := value.(string)
	return str
}

func copilotNumber(value any) int {
	switch typed := value.(type) {
	case float64:
		return int(typed)
	case int:
		return typed
	case json.Number:
		parsed, _ := typed.Int64()
		return int(parsed)
	}
	return 0
}

func fetchCopilotIdentity(ctx context.Context, client *http.Client, accessToken string) string {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, copilotUserEndpoint, nil)
	if err != nil {
		return ""
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(accessToken))
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", copilotUserAgent)
	resp, err := client.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return ""
	}
	var user struct {
		Login string `json:"login"`
		Email string `json:"email"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&user); err != nil {
		return ""
	}
	if strings.TrimSpace(user.Email) != "" {
		return strings.TrimSpace(user.Email)
	}
	return strings.TrimSpace(user.Login)
}

func (p copilotProvider) MakeRequest(ctx context.Context, client *http.Client, accessToken string, account appdb.ProviderAccount, body map[string]any, stream bool) (*http.Response, error) {
	modelName := p.resolveModel(stringValue(body["model"]))
	initiator, injectSystemTool := p.systemToolMode(ctx, account.ID)
	body = cloneAnyMap(body)
	if messages, ok := body["messages"].([]any); ok {
		messages = convertImageURLsToBase64(ctx, client, messages)
		if injectSystemTool {
			messages = injectCopilotChatSystemTool(messages)
		}
		body["messages"] = messages
	}
	if input, ok := body["_responsesInput"].([]any); ok {
		input = normalizeResponsesInput(input)
		input = convertResponsesInputImageURLsToBase64(ctx, client, input)
		if injectSystemTool {
			input = injectCopilotResponsesSystemTool(input)
			body["messages"] = responsesInputToChatMessages(input, stringValue(body["instructions"]))
		}
		body["_responsesInput"] = input
	}
	if p.requiresResponsesAPI(modelName) {
		payload := p.buildResponsesPayload(body, modelName, stream)
		resp, err := p.post(ctx, client, accessToken, "/responses", payload, stream, initiator, isCopilotVisionRequest(body))
		if err != nil || resp == nil || resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return resp, err
		}
		if stream {
			return sseResponse(responsesSSEToChatSSEReader(resp.Body, modelName), resp.Body), nil
		}
		var data map[string]any
		if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
			_ = resp.Body.Close()
			return nil, err
		}
		_ = resp.Body.Close()
		return jsonResponse(http.StatusOK, responsesJSONToChatCompletion(data, modelName)), nil
	}

	payload := filterKeys(body, supportedCopilot)
	payload["model"] = modelName
	payload["stream"] = stream
	if stream {
		payload["stream_options"] = map[string]any{"include_usage": true}
	}
	if !p.supportsReasoningEffort(modelName) {
		delete(payload, "reasoning")
		delete(payload, "reasoning_effort")
	}
	return p.post(ctx, client, accessToken, "/chat/completions", payload, stream, initiator, isCopilotVisionRequest(body))
}

var supportedCopilot = set("model", "messages", "temperature", "top_p", "max_tokens", "stream", "stream_options", "tools", "tool_choice", "presence_penalty", "frequency_penalty", "n", "stop", "seed", "response_format", "reasoning", "reasoning_effort")

func (p copilotProvider) post(ctx context.Context, client *http.Client, accessToken, path string, payload map[string]any, stream bool, initiator string, visionRequest bool) (*http.Response, error) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, copilotAPIBaseURL+path, bytes.NewReader(encoded))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(accessToken))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", map[bool]string{true: "text/event-stream", false: "application/json"}[stream])
	req.Header.Set("User-Agent", copilotUserAgent)
	req.Header.Set("Openai-Intent", copilotIntent)
	req.Header.Set("x-initiator", initiator)
	if visionRequest {
		req.Header.Set("Copilot-Vision-Request", "true")
	}
	resp, err := client.Do(req)
	if resp != nil {
		MarkUpstreamResponseStarted(ctx)
	}
	return resp, err
}

func (p copilotProvider) systemToolMode(ctx context.Context, accountID string) (string, bool) {
	if p.redis == nil || strings.TrimSpace(accountID) == "" {
		return "user", false
	}
	key := copilotSystemToolKey + ":" + strings.TrimSpace(accountID)
	res, err := p.redis.SetNX(ctx, key, "1", 5*time.Hour).Result()
	if err != nil || res {
		return "user", false
	}
	return "agent", true
}

func injectCopilotChatSystemTool(messages []any) []any {
	assistant := map[string]any{"role": "assistant", "content": nil, "tool_calls": []any{map[string]any{"id": "call_init", "type": "function", "function": map[string]any{"name": "get_context", "arguments": `{"query":"current year"}`}}}}
	tool := map[string]any{"role": "tool", "tool_call_id": "call_init", "name": "get_context", "content": fmt.Sprint(time.Now().Year())}
	out := []any{}
	inserted := false
	for _, raw := range messages {
		msg, _ := raw.(map[string]any)
		if !inserted && msg["role"] == "user" {
			out = append(out, assistant, tool)
			inserted = true
		}
		out = append(out, raw)
	}
	if !inserted {
		return append([]any{assistant, tool}, out...)
	}
	return out
}

func injectCopilotResponsesSystemTool(input []any) []any {
	return append([]any{
		map[string]any{"type": "function_call", "call_id": "call_init", "name": "get_context", "arguments": `{"query":"current year"}`},
		map[string]any{"type": "function_call_output", "call_id": "call_init", "output": fmt.Sprint(time.Now().Year())},
	}, input...)
}

func responsesInputToChatMessages(input []any, instructions string) []any {
	messages := []any{}
	if instructions != "" {
		messages = append(messages, map[string]any{"role": "system", "content": instructions})
	}
	pending := []any{}
	flush := func() {
		if len(pending) > 0 {
			messages = append(messages, map[string]any{"role": "assistant", "content": "", "tool_calls": pending})
			pending = []any{}
		}
	}
	for _, raw := range input {
		item, _ := raw.(map[string]any)
		switch item["type"] {
		case "message":
			flush()
			role := defaultStringValue(item["role"], "user")
			if role == "developer" {
				role = "system"
			}
			messages = append(messages, map[string]any{"role": role, "content": item["content"]})
		case "function_call":
			id := stringValue(item["call_id"])
			if id == "" {
				id = stringValue(item["id"])
			}
			pending = append(pending, map[string]any{"id": toChatCallID(id), "type": "function", "function": map[string]any{"name": stringValue(item["name"]), "arguments": defaultStringValue(item["arguments"], "{}")}})
		case "function_call_output":
			flush()
			messages = append(messages, map[string]any{"role": "tool", "tool_call_id": toChatCallID(stringValue(item["call_id"])), "content": defaultStringValue(item["output"], "")})
		}
	}
	flush()
	return messages
}

func isCopilotVisionRequest(body map[string]any) bool {
	if messages, ok := body["messages"].([]any); ok {
		for _, raw := range messages {
			msg, _ := raw.(map[string]any)
			parts, _ := msg["content"].([]any)
			for _, rawPart := range parts {
				part, _ := rawPart.(map[string]any)
				if part["type"] == "image_url" || part["type"] == "image" {
					return true
				}
			}
		}
	}
	if input, ok := body["_responsesInput"].([]any); ok {
		for _, raw := range input {
			item, _ := raw.(map[string]any)
			parts, _ := item["content"].([]any)
			for _, rawPart := range parts {
				part, _ := rawPart.(map[string]any)
				if part["type"] == "input_image" {
					return true
				}
			}
		}
	}
	return false
}

func (p copilotProvider) buildResponsesPayload(body map[string]any, modelName string, stream bool) map[string]any {
	messages, _ := body["messages"].([]any)
	payload := map[string]any{"model": modelName, "stream": stream}
	if input, ok := body["_responsesInput"].([]any); ok && len(input) > 0 {
		payload["input"] = normalizeResponsesInput(input)
	} else {
		payload["input"] = messagesToResponsesInput(messages)
	}
	if instructions := stringValue(body["instructions"]); instructions != "" {
		payload["instructions"] = instructions
	} else if derived := extractInstructions(messages); derived != "" {
		payload["instructions"] = derived
	}
	if tools := convertToolsForResponses(body["tools"]); len(tools) > 0 {
		payload["tools"] = tools
	}
	if body["tool_choice"] != nil {
		payload["tool_choice"] = body["tool_choice"]
	}
	if reasoning, ok := body["reasoning"].(map[string]any); ok {
		payload["reasoning"] = reasoning
	} else if effort := stringValue(body["reasoning_effort"]); effort != "" {
		payload["reasoning"] = map[string]any{"effort": effort}
	}
	if body["max_tokens"] != nil {
		payload["max_output_tokens"] = body["max_tokens"]
	}
	return payload
}

func (p copilotProvider) resolveModel(model string) string {
	model = lastModelSegment(model)
	if p.registry != nil {
		return p.registry.UpstreamModelName(model, "copilot")
	}
	return model
}

func (p copilotProvider) isReasoningModel(model string) bool {
	if p.registry == nil {
		return true
	}
	return p.registry.IsReasoningModel(model)
}

func (p copilotProvider) supportsReasoningEffort(model string) bool {
	if p.registry == nil {
		return true
	}
	if value, ok := providerConfigValue(p.registry, model, "copilot", "reasoning_effort"); ok {
		supported, _ := value.(bool)
		return supported
	}
	return p.isReasoningModel(model)
}

func (p copilotProvider) requiresResponsesAPI(model string) bool {
	return providerConfigBool(p.registry, model, "copilot", "responses_api")
}

func drainBody(resp *http.Response) string {
	if resp == nil || resp.Body == nil {
		return ""
	}
	data, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	return string(data)
}
