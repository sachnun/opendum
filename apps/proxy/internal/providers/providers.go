package providers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
	"github.com/opendum/opendum/apps/proxy/internal/models"
)

type Provider interface {
	MakeRequest(ctx context.Context, client *http.Client, credentials string, account appdb.ProviderAccount, body map[string]any, stream bool) (*http.Response, error)
}

type Registry struct {
	providers map[string]Provider
}

func NewRegistry(registry *models.Registry) *Registry {
	return &Registry{providers: map[string]Provider{
		"openrouter":   openAICompatibleProvider{name: "openrouter", baseURL: "https://openrouter.ai/api/v1", supportedParams: supportedOpenRouter, registry: registry, trimPrefix: "openrouter/"},
		"groq":         openAICompatibleProvider{name: "groq", baseURL: "https://api.groq.com/openai/v1", supportedParams: supportedGroq, registry: registry},
		"cerebras":     openAICompatibleProvider{name: "cerebras", baseURL: "https://api.cerebras.ai/v1", supportedParams: supportedCerebras, registry: registry},
		"nvidia_nim":   openAICompatibleProvider{name: "nvidia_nim", baseURL: "https://integrate.api.nvidia.com/v1", supportedParams: supportedNvidia, registry: registry, trimPrefix: "nvidia_nim/"},
		"ollama_cloud": openAICompatibleProvider{name: "ollama_cloud", baseURL: "https://ollama.com/v1", supportedParams: supportedOllama, registry: registry},
		"kilo_code":    openAICompatibleProvider{name: "kilo_code", baseURL: "https://api.kilo.ai/api/gateway", supportedParams: supportedKilo, registry: registry, trimPrefix: "kilo_code/"},
		"workers_ai":   workersAIProvider{registry: registry},
	}}
}

func (r *Registry) Get(name string) (Provider, bool) {
	provider, ok := r.providers[name]
	return provider, ok
}

type openAICompatibleProvider struct {
	name            string
	baseURL         string
	supportedParams map[string]struct{}
	registry        *models.Registry
	trimPrefix      string
}

func (p openAICompatibleProvider) MakeRequest(ctx context.Context, client *http.Client, credentials string, _ appdb.ProviderAccount, body map[string]any, stream bool) (*http.Response, error) {
	payload := p.buildPayload(body, stream)
	return postJSON(ctx, client, p.baseURL+"/chat/completions", credentials, payload, stream)
}

func (p openAICompatibleProvider) buildPayload(body map[string]any, stream bool) map[string]any {
	payload := map[string]any{}
	for key, value := range body {
		if _, ok := p.supportedParams[key]; ok && value != nil {
			payload[key] = value
		}
	}
	model, _ := body["model"].(string)
	if p.trimPrefix != "" && strings.HasPrefix(model, p.trimPrefix) {
		model = strings.TrimPrefix(model, p.trimPrefix)
	}
	payload["model"] = p.registry.UpstreamModelName(model, p.name)
	payload["stream"] = stream
	return payload
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
	url := "https://api.cloudflare.com/client/v4/accounts/" + strings.TrimSpace(*account.AccountID) + "/ai/v1/chat/completions"
	return postJSON(ctx, client, url, credentials, payload, stream)
}

func postJSON(ctx context.Context, client *http.Client, url, bearer string, payload map[string]any, stream bool) (*http.Response, error) {
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
	return client.Do(req)
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
