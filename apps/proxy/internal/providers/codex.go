package providers

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
	"github.com/opendum/opendum/apps/proxy/internal/models"
)

const (
	codexClientID      = "app_EMoamEEZ73f0CkXaXp7hrann"
	codexTokenEndpoint = "https://auth.openai.com/oauth/token"
	codexAPIBaseURL    = "https://chatgpt.com/backend-api/codex/responses"
	codexOriginator    = "opencode"
)

var supportedCodex = set("model", "instructions", "store", "input", "stream", "tools", "tool_choice", "parallel_tool_calls", "reasoning", "include", "previous_response_id", "prompt_cache_key", "client_metadata", "service_tier")

type codexProvider struct {
	registry *models.Registry
	redis    *redis.Client
	db       *appdb.DB
}

func (p codexProvider) RefreshBuffer() time.Duration { return 5 * time.Minute }

func (p codexProvider) RefreshCredentials(ctx context.Context, client *http.Client, refreshToken string, _ appdb.ProviderAccount) (RefreshedCredentials, error) {
	form := url.Values{}
	form.Set("grant_type", "refresh_token")
	form.Set("refresh_token", strings.TrimSpace(refreshToken))
	form.Set("client_id", codexClientID)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, codexTokenEndpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return RefreshedCredentials{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return RefreshedCredentials{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body := readLimit(resp.Body, 1<<20)
		return RefreshedCredentials{}, fmt.Errorf("codex token refresh failed: %d %s", resp.StatusCode, body)
	}
	var token struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int64  `json:"expires_in"`
		IDToken      string `json:"id_token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&token); err != nil {
		return RefreshedCredentials{}, err
	}
	if token.AccessToken == "" {
		return RefreshedCredentials{}, fmt.Errorf("codex token refresh returned empty access token")
	}
	if token.RefreshToken == "" {
		token.RefreshToken = refreshToken
	}
	if token.ExpiresIn <= 0 {
		token.ExpiresIn = 3600
	}
	accountID := extractAccountIDFromJWT(token.AccessToken)
	if accountID == "" && token.IDToken != "" {
		accountID = extractAccountIDFromJWT(token.IDToken)
	}
	return RefreshedCredentials{AccessToken: token.AccessToken, RefreshToken: token.RefreshToken, ExpiresAt: time.Now().Add(time.Duration(token.ExpiresIn) * time.Second), AccountID: accountID}, nil
}

func (p codexProvider) MakeRequest(ctx context.Context, client *http.Client, accessToken string, account appdb.ProviderAccount, body map[string]any, stream bool) (*http.Response, error) {
	modelName := p.resolveModel(stringValue(body["model"]))
	if account.AccountID == nil || strings.TrimSpace(*account.AccountID) == "" {
		if accountID := extractAccountIDFromJWT(accessToken); accountID != "" {
			account.AccountID = &accountID
			if p.db != nil && account.ID != "" {
				_, _ = p.db.NewUpdate().Model((*appdb.ProviderAccount)(nil)).Set("\"accountId\" = ?", accountID).Where("id = ?", account.ID).Exec(ctx)
			}
		}
	}
	if !p.isModelAllowed(modelName) {
		return jsonResponse(http.StatusBadRequest, map[string]any{"error": map[string]any{"message": fmt.Sprintf("Model \"%s\" is not supported for Codex when using a ChatGPT account. Use one of: %s.", modelName, strings.Join(p.supportedModelNames(), ", ")), "type": "invalid_request_error", "param": "model", "code": "unsupported_codex_chatgpt_model"}}), nil
	}
	payload := p.buildPayload(body, modelName, true)
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, codexAPIBaseURL, bytes.NewReader(encoded))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(accessToken))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("originator", codexOriginator)
	req.Header.Set("User-Agent", fmt.Sprintf("opencode/1.14.28 (%s %s; %s)", runtime.GOOS, runtime.GOOS, runtime.GOARCH))
	if accountID := accountIDForCodex(account, accessToken); accountID != "" {
		req.Header.Set("ChatGPT-Account-Id", accountID)
	}
	if sessionID := stringValue(body["_sessionId"]); sessionID != "" {
		req.Header.Set("session_id", sessionID)
	}

	resp, err := client.Do(req)
	if err != nil || resp == nil || resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return resp, err
	}
	p.updateQuotaFromHeaders(ctx, account.ID, resp.Header)
	if stream {
		return sseResponse(responsesSSEToChatSSEReader(resp.Body, modelName), resp.Body), nil
	}
	converted := responsesStreamToCompletion(resp.Body, modelName)
	_ = resp.Body.Close()
	return jsonResponse(http.StatusOK, converted), nil
}

func accountIDForCodex(account appdb.ProviderAccount, accessToken string) string {
	if account.AccountID != nil && strings.TrimSpace(*account.AccountID) != "" {
		return strings.TrimSpace(*account.AccountID)
	}
	return extractAccountIDFromJWT(accessToken)
}

func (p codexProvider) isModelAllowed(model string) bool {
	if p.registry == nil {
		return true
	}
	normalized := strings.ToLower(strings.TrimSpace(model))
	for canonical, upstream := range p.registry.ProviderModelMap("codex") {
		if strings.ToLower(canonical) == normalized || strings.ToLower(upstream) == normalized {
			return true
		}
	}
	return false
}

func (p codexProvider) supportedModelNames() []string {
	if p.registry == nil {
		return nil
	}
	values := []string{}
	seen := map[string]struct{}{}
	for canonical, upstream := range p.registry.ProviderModelMap("codex") {
		for _, value := range []string{canonical, upstream} {
			if value == "" {
				continue
			}
			if _, ok := seen[value]; ok {
				continue
			}
			seen[value] = struct{}{}
			values = append(values, value)
		}
	}
	sort.Strings(values)
	return values
}

func (p codexProvider) updateQuotaFromHeaders(ctx context.Context, accountID string, headers http.Header) {
	if p.redis == nil || accountID == "" {
		return
	}
	snapshot := parseCodexQuotaHeaders(headers)
	if len(snapshot) == 0 {
		return
	}
	snapshot["status"] = "success"
	snapshot["source"] = "headers"
	snapshot["fetchedAt"] = time.Now().UnixMilli()
	data, err := json.Marshal(snapshot)
	if err != nil {
		return
	}
	_ = p.redis.Set(ctx, "opendum:quota:codex:snapshot:"+accountID, data, 15*time.Minute).Err()
}

func parseCodexQuotaHeaders(headers http.Header) map[string]any {
	primaryUsed := headers.Get("x-codex-primary-used-percent")
	secondaryUsed := headers.Get("x-codex-secondary-used-percent")
	credits := headers.Get("x-codex-credits-has-credits")
	if primaryUsed == "" && secondaryUsed == "" && credits == "" {
		return nil
	}
	snapshot := map[string]any{"planType": nil, "primary": nil, "secondary": nil, "credits": nil}
	if primaryUsed != "" {
		snapshot["primary"] = quotaWindow(primaryUsed, headers.Get("x-codex-primary-window-minutes"), headers.Get("x-codex-primary-reset-at"))
	}
	if secondaryUsed != "" {
		snapshot["secondary"] = quotaWindow(secondaryUsed, headers.Get("x-codex-secondary-window-minutes"), headers.Get("x-codex-secondary-reset-at"))
	}
	if credits != "" {
		snapshot["credits"] = map[string]any{"hasCredits": parseBoolString(credits), "unlimited": parseBoolString(headers.Get("x-codex-credits-unlimited")), "balance": nullableString(headers.Get("x-codex-credits-balance"))}
	}
	return snapshot
}

func quotaWindow(used, windowMinutes, resetAt string) map[string]any {
	usedPercent := parseFloatString(used)
	remaining := 100 - usedPercent
	if remaining < 0 {
		remaining = 0
	}
	return map[string]any{"usedPercent": usedPercent, "remainingPercent": remaining, "remainingFraction": remaining / 100, "windowMinutes": parseIntString(windowMinutes), "resetAt": parseIntString(resetAt), "resetTimestamp": resetTimestamp(parseIntString(resetAt)), "isExhausted": usedPercent >= 100}
}

func (p codexProvider) buildPayload(body map[string]any, modelName string, upstreamStream bool) map[string]any {
	messages, _ := body["messages"].([]any)
	payload := map[string]any{"model": modelName, "store": false, "stream": upstreamStream}
	if instructions := stringValue(body["instructions"]); instructions != "" {
		payload["instructions"] = instructions
	} else if derived := extractInstructions(messages); derived != "" {
		payload["instructions"] = derived
	} else {
		payload["instructions"] = "You are Codex, an expert coding assistant."
	}
	if input, ok := body["_responsesInput"].([]any); ok && len(input) > 0 {
		payload["input"] = normalizeResponsesInput(input)
	} else {
		payload["input"] = messagesToResponsesInput(messages)
	}
	if tools := convertToolsForResponses(body["tools"]); len(tools) > 0 {
		payload["tools"] = tools
		if body["tool_choice"] == nil {
			payload["tool_choice"] = "auto"
		}
	}
	if body["tool_choice"] != nil {
		payload["tool_choice"] = normalizeToolChoice(body["tool_choice"])
	}
	if body["parallel_tool_calls"] != nil {
		payload["parallel_tool_calls"] = body["parallel_tool_calls"]
	}
	if reasoning, ok := body["reasoning"].(map[string]any); ok {
		payload["reasoning"] = cloneAnyMap(reasoning)
	} else if effort := stringValue(body["reasoning_effort"]); effort != "" {
		payload["reasoning"] = map[string]any{"effort": effort}
	}
	if reasoning, ok := payload["reasoning"].(map[string]any); ok && body["_includeReasoning"] == true && reasoning["summary"] == nil {
		reasoning["summary"] = "auto"
	}
	include := stringSlice(body["include"])
	if body["_includeReasoning"] == true || len(convertToolsForResponses(body["tools"])) > 0 {
		include = append(include, "reasoning.encrypted_content")
	}
	if len(include) > 0 {
		payload["include"] = uniqueStrings(include)
	}
	for _, key := range []string{"previous_response_id", "service_tier"} {
		if body[key] != nil {
			payload[key] = body[key]
		}
	}
	if sessionID := stringValue(body["_sessionId"]); sessionID != "" {
		payload["prompt_cache_key"] = sessionID
		payload["client_metadata"] = map[string]any{"session_id": sessionID}
	}
	return filterKeys(payload, supportedCodex)
}

func (p codexProvider) resolveModel(model string) string {
	model = lastModelSegment(model)
	if p.registry != nil {
		return p.registry.UpstreamModelName(model, "codex")
	}
	return model
}

func normalizeToolChoice(value any) any {
	choice, ok := value.(map[string]any)
	if !ok || choice["type"] != "function" {
		return value
	}
	fn, _ := choice["function"].(map[string]any)
	name := stringValue(fn["name"])
	if name == "" {
		name = stringValue(choice["name"])
	}
	if name == "" {
		return value
	}
	return map[string]any{"type": "function", "name": name}
}

func responsesStreamToCompletion(body io.Reader, model string) map[string]any {
	text, _ := io.ReadAll(body)
	events := parseSSEDataLines(string(text))
	completion := map[string]any{"output": []any{}, "usage": map[string]any{}}
	messageContent := ""
	reasoning := ""
	toolCalls := []any{}
	currentTool := map[string]any{}
	for _, event := range events {
		typ := stringValue(event["type"])
		switch typ {
		case "response.output_text.delta":
			messageContent += stringValue(event["delta"])
		case "response.reasoning.delta", "response.reasoning_text.delta", "response.reasoning_summary_text.delta":
			reasoning += stringValue(event["delta"])
		case "response.output_item.added":
			item, _ := event["item"].(map[string]any)
			if item["type"] == "function_call" {
				currentTool = map[string]any{"type": "function_call", "id": item["id"], "call_id": item["call_id"], "name": item["name"], "arguments": ""}
			}
		case "response.function_call_arguments.delta", "response.custom_tool_call_input.delta":
			if currentTool != nil {
				currentTool["arguments"] = stringValue(currentTool["arguments"]) + stringValue(event["delta"])
			}
		case "response.function_call_arguments.done", "response.output_item.done":
			if currentTool != nil {
				toolCalls = append(toolCalls, currentTool)
				currentTool = nil
			}
		case "response.completed", "response.done":
			resp, _ := event["response"].(map[string]any)
			if resp == nil {
				resp = event
			}
			completion["status"] = resp["status"]
			completion["usage"] = resp["usage"]
		}
	}
	output := []any{}
	if messageContent != "" {
		output = append(output, map[string]any{"type": "message", "content": []any{map[string]any{"type": "output_text", "text": messageContent}}})
	}
	if reasoning != "" {
		output = append(output, map[string]any{"type": "reasoning", "text": reasoning})
	}
	output = append(output, toolCalls...)
	completion["output"] = output
	return responsesJSONToChatCompletion(completion, model)
}

func parseSSEDataLines(text string) []map[string]any {
	events := []map[string]any{}
	for _, line := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "" || data == "[DONE]" {
			continue
		}
		var event map[string]any
		if err := json.Unmarshal([]byte(data), &event); err == nil {
			events = append(events, event)
		}
	}
	return events
}

func jwtStringClaim(token, claim string) string {
	claims := jwtClaims(token)
	if claims == nil {
		return ""
	}
	if value := stringValue(claims[claim]); value != "" {
		return value
	}
	if auth, ok := claims["https://api.openai.com/auth"].(map[string]any); ok {
		return stringValue(auth[claim])
	}
	return ""
}

func jwtClaims(token string) map[string]any {
	parts := strings.Split(token, ".")
	if len(parts) < 2 {
		return nil
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil
	}
	var claims map[string]any
	if err := json.Unmarshal(payload, &claims); err != nil {
		return nil
	}
	return claims
}

func extractAccountIDFromJWT(token string) string {
	claims := jwtClaims(token)
	if claims == nil {
		return ""
	}
	if accountID := firstStringClaim(claims, "chatgpt_account_id"); accountID != "" {
		return accountID
	}
	return extractWorkspaceIDFromClaims(claims)
}

func extractWorkspaceIDFromClaims(claims map[string]any) string {
	auth, _ := claims["https://api.openai.com/auth"].(map[string]any)
	for _, source := range []map[string]any{auth, claims} {
		if source == nil {
			continue
		}
		for _, key := range []string{"chatgpt_workspace_id", "workspace_id", "organization_id"} {
			if value := firstStringClaim(source, key); value != "" {
				return value
			}
		}
		if value := extractOrganizationID(source); value != "" {
			return value
		}
	}
	return ""
}

func firstStringClaim(claims map[string]any, key string) string {
	return strings.TrimSpace(stringValue(claims[key]))
}

func extractOrganizationID(claims map[string]any) string {
	organizations, _ := claims["organizations"].([]any)
	for _, preferDefault := range []bool{true, false} {
		for _, raw := range organizations {
			org, _ := raw.(map[string]any)
			if org == nil {
				continue
			}
			isDefault := org["is_default"] == true || org["default"] == true
			if preferDefault && !isDefault {
				continue
			}
			if value := strings.TrimSpace(stringValue(org["id"])); value != "" {
				return value
			}
		}
	}
	return ""
}

func filterKeys(input map[string]any, supported map[string]struct{}) map[string]any {
	out := map[string]any{}
	for key, value := range input {
		if _, ok := supported[key]; ok && value != nil {
			out[key] = value
		}
	}
	return out
}

func stringSlice(value any) []string {
	items, _ := value.([]any)
	out := []string{}
	for _, item := range items {
		if str := stringValue(item); str != "" {
			out = append(out, str)
		}
	}
	return out
}

func uniqueStrings(values []string) []string {
	seen := map[string]struct{}{}
	out := []string{}
	for _, value := range values {
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}

func parseFloatString(value string) float64 {
	parsed, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
	if err != nil || parsed < 0 {
		return 0
	}
	if parsed > 100 {
		return 100
	}
	return parsed
}

func parseIntString(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	parsed, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
	if err != nil {
		return nil
	}
	return parsed
}

func resetTimestamp(value any) any {
	parsed, ok := value.(int64)
	if !ok || parsed <= 0 {
		return nil
	}
	if parsed > 10_000_000_000 {
		return parsed
	}
	return parsed * 1000
}

func parseBoolString(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "true", "1":
		return true
	default:
		return false
	}
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}
