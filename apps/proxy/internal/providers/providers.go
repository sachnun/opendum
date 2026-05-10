package providers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
	"github.com/opendum/opendum/apps/proxy/internal/models"
)

const qwenCodeTokenEndpoint = "https://chat.qwen.ai/api/v1/oauth2/token"
const qwenCodeClientID = "f0304373b74a44d2b584a3fb70ca9e56"
const oauthRefreshBuffer = 3 * time.Hour

type Provider interface {
	MakeRequest(ctx context.Context, client *http.Client, credentials string, account appdb.ProviderAccount, body map[string]any, stream bool) (*http.Response, error)
}

type CredentialRefresher interface {
	RefreshCredentials(ctx context.Context, client *http.Client, refreshToken string, account appdb.ProviderAccount) (RefreshedCredentials, error)
}

type RefreshBufferProvider interface {
	RefreshBuffer() time.Duration
}

type RefreshedCredentials struct {
	AccessToken  string
	RefreshToken string
	ExpiresAt    time.Time
	ProjectID    string
	Tier         string
	Email        string
	AccountID    string
}

type Registry struct {
	providers map[string]Provider
}

func NewRegistry(registry *models.Registry, db *appdb.DB, redis *redis.Client) *Registry {
	return &Registry{providers: map[string]Provider{
		"openrouter":   openAICompatibleProvider{name: "openrouter", baseURL: "https://openrouter.ai/api/v1", supportedParams: supportedOpenRouter, registry: registry, trimPrefix: "openrouter/"},
		"groq":         openAICompatibleProvider{name: "groq", baseURL: "https://api.groq.com/openai/v1", supportedParams: supportedGroq, registry: registry},
		"cerebras":     openAICompatibleProvider{name: "cerebras", baseURL: "https://api.cerebras.ai/v1", supportedParams: supportedCerebras, registry: registry},
		"nvidia_nim":   openAICompatibleProvider{name: "nvidia_nim", baseURL: "https://integrate.api.nvidia.com/v1", supportedParams: supportedNvidia, registry: registry, trimPrefix: "nvidia_nim/"},
		"ollama_cloud": openAICompatibleProvider{name: "ollama_cloud", baseURL: "https://ollama.com/v1", supportedParams: supportedOllama, registry: registry},
		"kilo_code":    openAICompatibleProvider{name: "kilo_code", baseURL: "https://api.kilo.ai/api/gateway", supportedParams: supportedKilo, registry: registry, trimPrefix: "kilo_code/"},
		"workers_ai":   workersAIProvider{registry: registry},
		"qwen_code":    qwenCodeProvider{registry: registry},
		"kiro":         kiroProvider{registry: registry},
		"codex":        codexProvider{registry: registry, redis: redis, db: db},
		"copilot":      copilotProvider{registry: registry, redis: redis},
		"gemini_cli":   geminiCLIProvider{registry: registry, db: db, redis: redis},
		"antigravity":  antigravityProvider{registry: registry, db: db, redis: redis},
	}}
}

func (r *Registry) Get(name string) (Provider, bool) {
	provider, ok := r.providers[name]
	return provider, ok
}

func (r *Registry) RefreshableProviderNames() []string {
	if r == nil {
		return nil
	}
	names := make([]string, 0, len(r.providers))
	for name, provider := range r.providers {
		if _, ok := provider.(CredentialRefresher); ok {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	return names
}

func RefreshBufferFor(provider Provider) time.Duration {
	if customBuffer, ok := provider.(RefreshBufferProvider); ok {
		return customBuffer.RefreshBuffer()
	}
	return oauthRefreshBuffer
}

type openAICompatibleProvider struct {
	name            string
	baseURL         string
	supportedParams map[string]struct{}
	registry        *models.Registry
	trimPrefix      string
}

func (p openAICompatibleProvider) MakeRequest(ctx context.Context, client *http.Client, credentials string, _ appdb.ProviderAccount, body map[string]any, stream bool) (*http.Response, error) {
	model := p.normalizeModel(stringValue(body["model"]))
	modelName := p.resolveModel(model)
	if p.requiresResponsesAPI(model) {
		payload := p.buildResponsesPayload(body, modelName, stream)
		resp, err := postJSON(ctx, client, p.baseURL+"/responses", credentials, payload, stream)
		if err != nil || resp == nil || resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return resp, err
		}
		if _, nativeResponses := body["_responsesInput"].([]any); nativeResponses {
			return resp, nil
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

	payload := p.buildPayload(body, modelName, stream)
	if p.name == "ollama_cloud" {
		if messages, ok := payload["messages"].([]any); ok {
			payload["messages"] = convertImageURLsToBase64(ctx, client, messages)
		}
	}
	return postJSON(ctx, client, p.baseURL+"/chat/completions", credentials, payload, stream)
}

func (p openAICompatibleProvider) buildPayload(body map[string]any, modelName string, stream bool) map[string]any {
	payload := map[string]any{}
	for key, value := range body {
		if _, ok := p.supportedParams[key]; ok && value != nil {
			payload[key] = value
		}
	}
	payload["model"] = modelName
	payload["stream"] = stream
	return payload
}

func (p openAICompatibleProvider) buildResponsesPayload(body map[string]any, modelName string, stream bool) map[string]any {
	messages, _ := body["messages"].([]any)
	payload := map[string]any{"model": modelName, "stream": stream}
	if input, ok := body["_responsesInput"].([]any); ok {
		payload["input"] = normalizeResponsesInput(input)
	} else {
		payload["input"] = messagesToResponsesInput(messages)
	}
	if instructions := stringValue(body["instructions"]); instructions != "" {
		payload["instructions"] = instructions
	}
	if body["temperature"] != nil {
		payload["temperature"] = body["temperature"]
	}
	if body["top_p"] != nil {
		payload["top_p"] = body["top_p"]
	}
	if body["max_tokens"] != nil {
		payload["max_output_tokens"] = body["max_tokens"]
	} else if body["max_completion_tokens"] != nil {
		payload["max_output_tokens"] = body["max_completion_tokens"]
	}
	if tools := convertToolsForResponses(body["tools"]); len(tools) > 0 {
		payload["tools"] = tools
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
	for _, key := range []string{"include", "previous_response_id", "prompt_cache_key", "service_tier", "store", "text", "truncation", "user"} {
		if body[key] != nil {
			payload[key] = body[key]
		}
	}
	return payload
}

func (p openAICompatibleProvider) normalizeModel(model string) string {
	if p.trimPrefix != "" && strings.HasPrefix(model, p.trimPrefix) {
		return strings.TrimPrefix(model, p.trimPrefix)
	}
	return model
}

func (p openAICompatibleProvider) resolveModel(model string) string {
	if p.registry != nil {
		return p.registry.UpstreamModelName(model, p.name)
	}
	return model
}

func (p openAICompatibleProvider) requiresResponsesAPI(model string) bool {
	return providerConfigBool(p.registry, model, p.name, "responses_api")
}

type workersAIProvider struct {
	registry *models.Registry
}

func (p workersAIProvider) MakeRequest(ctx context.Context, client *http.Client, credentials string, account appdb.ProviderAccount, body map[string]any, stream bool) (*http.Response, error) {
	if account.AccountID == nil || strings.TrimSpace(*account.AccountID) == "" {
		return nil, fmt.Errorf("missing Cloudflare Account ID on Workers AI account")
	}
	payload := map[string]any{}
	for key, value := range body {
		if _, ok := supportedWorkersAI[key]; ok && value != nil {
			payload[key] = value
		}
	}
	model, _ := body["model"].(string)
	payload["model"] = p.registry.UpstreamModelName(model, "workers_ai")
	payload["stream"] = stream
	if messages, ok := payload["messages"].([]any); ok {
		payload["messages"] = convertImageURLsToBase64(ctx, client, messages)
	}
	url := "https://api.cloudflare.com/client/v4/accounts/" + strings.TrimSpace(*account.AccountID) + "/ai/v1/chat/completions"
	return postJSON(ctx, client, url, credentials, payload, stream)
}

type qwenCodeProvider struct {
	registry *models.Registry
}

func (p qwenCodeProvider) RefreshBuffer() time.Duration { return 3 * time.Hour }

func (p qwenCodeProvider) RefreshCredentials(ctx context.Context, client *http.Client, refreshToken string, _ appdb.ProviderAccount) (RefreshedCredentials, error) {
	form := url.Values{}
	form.Set("grant_type", "refresh_token")
	form.Set("refresh_token", strings.TrimSpace(refreshToken))
	form.Set("client_id", qwenCodeClientID)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, qwenCodeTokenEndpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return RefreshedCredentials{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")

	resp, err := client.Do(req)
	if err != nil {
		return RefreshedCredentials{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body := readLimit(resp.Body, 1<<20)
		return RefreshedCredentials{}, fmt.Errorf("qwen_code token refresh failed: %d %s", resp.StatusCode, body)
	}

	var token struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int64  `json:"expires_in"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&token); err != nil {
		return RefreshedCredentials{}, err
	}
	if strings.TrimSpace(token.AccessToken) == "" {
		return RefreshedCredentials{}, fmt.Errorf("qwen_code token refresh returned empty access token")
	}
	if token.RefreshToken == "" {
		token.RefreshToken = refreshToken
	}
	if token.ExpiresIn <= 0 {
		token.ExpiresIn = 3600
	}
	return RefreshedCredentials{AccessToken: token.AccessToken, RefreshToken: token.RefreshToken, ExpiresAt: time.Now().Add(time.Duration(token.ExpiresIn) * time.Second)}, nil
}

func (p qwenCodeProvider) MakeRequest(ctx context.Context, client *http.Client, credentials string, _ appdb.ProviderAccount, body map[string]any, stream bool) (*http.Response, error) {
	payload := p.buildPayload(body, stream)
	resp, err := postJSONWithHeaders(ctx, client, "https://portal.qwen.ai/v1/chat/completions", credentials, payload, stream, map[string]string{
		"User-Agent":        "google-api-nodejs-client/9.15.1",
		"X-Goog-Api-Client": "gl-node/22.17.0",
		"Client-Metadata":   "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI",
	})
	if err != nil || !stream || resp == nil || resp.Body == nil || resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return resp, err
	}
	resp.Body = &qwenThinkTagReadCloser{reader: io.NopCloser(newQwenThinkTagReader(resp.Body)), closer: resp.Body}
	resp.Header.Set("Content-Type", "text/event-stream")
	resp.Header.Set("Cache-Control", "no-cache")
	resp.Header.Set("Connection", "keep-alive")
	return resp, nil
}

func (p qwenCodeProvider) buildPayload(body map[string]any, stream bool) map[string]any {
	payload := map[string]any{}
	for key, value := range body {
		if _, ok := supportedQwenCode[key]; ok && value != nil {
			payload[key] = value
		}
	}
	model, _ := body["model"].(string)
	if strings.HasPrefix(model, "qwen_code/") {
		model = strings.TrimPrefix(model, "qwen_code/")
	}
	if p.registry != nil {
		model = p.registry.UpstreamModelName(model, "qwen_code")
	}
	payload["model"] = model
	payload["stream"] = stream
	if stream {
		payload["stream_options"] = map[string]any{"include_usage": true}
	}
	if tools, ok := payload["tools"].([]any); ok {
		if len(tools) > 0 {
			payload["tools"] = cleanQwenTools(tools)
		} else if stream {
			payload["tools"] = []any{map[string]any{"type": "function", "function": map[string]any{"name": "do_not_call_me", "description": "Do not call this tool.", "parameters": map[string]any{"type": "object", "properties": map[string]any{}}}}}
		}
	}
	return payload
}

func postJSON(ctx context.Context, client *http.Client, url, bearer string, payload map[string]any, stream bool) (*http.Response, error) {
	return postJSONWithHeaders(ctx, client, url, bearer, payload, stream, nil)
}

func postJSONWithHeaders(ctx context.Context, client *http.Client, url, bearer string, payload map[string]any, stream bool, extraHeaders map[string]string) (*http.Response, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(bearer))
	req.Header.Set("Content-Type", "application/json")
	if stream {
		req.Header.Set("Accept", "text/event-stream")
	} else {
		req.Header.Set("Accept", "application/json")
	}
	for key, value := range extraHeaders {
		req.Header.Set(key, value)
	}
	return client.Do(req)
}

func shouldRefresh(account appdb.ProviderAccount) bool {
	return time.Now().After(account.ExpiresAt.Add(-oauthRefreshBuffer))
}

func cleanQwenTools(tools []any) []any {
	cleaned := make([]any, 0, len(tools))
	for _, raw := range tools {
		tool, ok := raw.(map[string]any)
		if !ok {
			cleaned = append(cleaned, raw)
			continue
		}
		copyTool := cloneAnyMap(tool)
		fn, _ := copyTool["function"].(map[string]any)
		if fn != nil {
			delete(fn, "strict")
			if params, ok := fn["parameters"].(map[string]any); ok {
				cleanQwenSchema(params)
			}
		}
		cleaned = append(cleaned, copyTool)
	}
	return cleaned
}

func cleanQwenSchema(schema map[string]any) {
	delete(schema, "additionalProperties")
	delete(schema, "strict")
	if props, ok := schema["properties"].(map[string]any); ok {
		for _, raw := range props {
			if child, ok := raw.(map[string]any); ok {
				cleanQwenSchema(child)
			}
		}
	}
	if items, ok := schema["items"].(map[string]any); ok {
		cleanQwenSchema(items)
	}
}

func cloneAnyMap(input map[string]any) map[string]any {
	out := make(map[string]any, len(input))
	for key, value := range input {
		if nested, ok := value.(map[string]any); ok {
			out[key] = cloneAnyMap(nested)
			continue
		}
		out[key] = value
	}
	return out
}

func readLimit(r io.Reader, limit int64) string {
	data, _ := io.ReadAll(io.LimitReader(r, limit))
	return string(data)
}

func set(values ...string) map[string]struct{} {
	out := make(map[string]struct{}, len(values))
	for _, value := range values {
		out[value] = struct{}{}
	}
	return out
}

var supportedOpenRouter = set("model", "messages", "temperature", "top_p", "max_tokens", "max_completion_tokens", "stream", "stream_options", "tools", "tool_choice", "presence_penalty", "frequency_penalty", "n", "stop", "seed", "response_format", "reasoning", "reasoning_effort")
var supportedGroq = set("model", "messages", "temperature", "top_p", "max_tokens", "max_completion_tokens", "stream", "stream_options", "tools", "tool_choice", "presence_penalty", "frequency_penalty", "stop", "seed", "response_format", "reasoning_effort", "n")
var supportedCerebras = set("model", "messages", "temperature", "top_p", "max_tokens", "max_completion_tokens", "stream", "stream_options", "tools", "tool_choice", "parallel_tool_calls", "stop", "seed", "response_format", "reasoning_effort", "n", "logprobs", "top_logprobs")
var supportedNvidia = set("model", "messages", "temperature", "top_p", "max_tokens", "stream", "tools", "tool_choice", "presence_penalty", "frequency_penalty", "n", "stop", "seed", "response_format")
var supportedOllama = set("model", "messages", "temperature", "top_p", "max_tokens", "stream", "tools", "tool_choice", "presence_penalty", "frequency_penalty", "n", "stop", "seed", "response_format")
var supportedKilo = set("model", "messages", "temperature", "top_p", "max_tokens", "max_completion_tokens", "stream", "stream_options", "tools", "tool_choice", "presence_penalty", "frequency_penalty", "n", "stop", "seed", "response_format", "reasoning", "reasoning_effort")
var supportedWorkersAI = set("model", "messages", "temperature", "top_p", "max_tokens", "stream", "stream_options", "tools", "tool_choice", "presence_penalty", "frequency_penalty", "stop", "seed", "response_format", "n")
var supportedQwenCode = set("model", "messages", "temperature", "top_p", "max_tokens", "stream", "tools", "tool_choice", "presence_penalty", "frequency_penalty", "n", "stop", "seed", "response_format")
