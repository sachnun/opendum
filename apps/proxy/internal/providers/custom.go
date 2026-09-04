package providers

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"strings"

	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
	"github.com/opendum/opendum/apps/proxy/internal/models"
)

var customProviderNamePattern = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,31}$`)

var reservedExtraHeaders = set("connection", "transfer-encoding", "host", "content-length", "upgrade", "keep-alive", "proxy-connection", "te", "trailer")

var defaultCustomSupportedParams = set("model", "messages", "temperature", "top_p", "max_tokens", "max_completion_tokens", "stream", "stream_options", "tools", "tool_choice", "parallel_tool_calls", "presence_penalty", "frequency_penalty", "n", "stop", "seed", "response_format", "reasoning", "reasoning_effort")

type CustomProviderConfig struct {
	Name            string            `json:"name"`
	BaseURL         string            `json:"baseUrl"`
	SupportedParams []string          `json:"supportedParams"`
	TrimPrefix      string            `json:"trimPrefix"`
	ExtraHeaders    map[string]string `json:"extraHeaders"`
}

func LoadCustomProviderConfigs() ([]CustomProviderConfig, error) {
	raw := strings.TrimSpace(os.Getenv("CUSTOM_PROVIDERS"))
	if raw == "" {
		path := strings.TrimSpace(os.Getenv("CUSTOM_PROVIDERS_FILE"))
		if path != "" {
			content, err := os.ReadFile(path)
			if err != nil {
				return nil, err
			}
			raw = strings.TrimSpace(string(content))
		}
	}
	if raw == "" {
		return nil, nil
	}
	var configs []CustomProviderConfig
	if err := json.Unmarshal([]byte(raw), &configs); err != nil {
		return nil, err
	}
	for i := range configs {
		if err := configs[i].validate(); err != nil {
			return nil, err
		}
	}
	return configs, nil
}

func (c *CustomProviderConfig) validate() error {
	c.Name = strings.ToLower(strings.TrimSpace(c.Name))
	if !customProviderNamePattern.MatchString(c.Name) {
		return fmt.Errorf("invalid custom provider name %q", c.Name)
	}
	baseURL := strings.TrimRight(strings.TrimSpace(c.BaseURL), "/")
	parsed, err := url.Parse(baseURL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return fmt.Errorf("invalid custom provider baseURL %q", c.BaseURL)
	}
	c.BaseURL = baseURL
	if strings.TrimSpace(c.TrimPrefix) == "" {
		c.TrimPrefix = c.Name + "/"
	} else {
		c.TrimPrefix = strings.TrimSpace(c.TrimPrefix)
	}
	for key, value := range c.ExtraHeaders {
		if strings.TrimSpace(key) == "" || strings.ContainsAny(key, ":\r\n") {
			return fmt.Errorf("invalid custom provider extra header name %q", key)
		}
		if strings.ContainsAny(value, "\r\n") {
			return fmt.Errorf("invalid custom provider extra header value for %q", key)
		}
		if _, blocked := reservedExtraHeaders[strings.ToLower(key)]; blocked {
			return fmt.Errorf("custom provider extra header %q is reserved", key)
		}
	}
	return nil
}

func CompileCustomProvider(provider *appdb.CustomProvider, models []appdb.CustomProviderModel) Provider {
	byModel := map[string]appdb.CustomProviderModel{}
	for _, row := range models {
		byModel[row.ModelID] = row
	}
	upstream := func(model string) string {
		row, ok := byModel[model]
		if !ok || strings.TrimSpace(row.Upstream) == "" {
			return model
		}
		return row.Upstream
	}
	flags := func(model string) map[string]any {
		row, ok := byModel[model]
		if !ok {
			return nil
		}
		return row.CustomFlags
	}
	authless := func(model string) bool {
		row, ok := byModel[model]
		return ok && row.Authless
	}
	return openAICompatibleProvider{
		name:            provider.Slug,
		baseURL:         provider.BaseURL,
		supportedParams: defaultCustomSupportedParams,
		trimPrefix:      provider.Slug + "/",
		extraHeaders:    provider.ExtraHeaders,
		upstreamName:    upstream,
		modelFlags:      flags,
		isAuthless:      authless,
	}
}

func (c CustomProviderConfig) provider(registry *models.Registry) Provider {
	params := make(map[string]struct{}, len(c.SupportedParams)+len(defaultCustomSupportedParams))
	if len(c.SupportedParams) == 0 {
		for key := range defaultCustomSupportedParams {
			params[key] = struct{}{}
		}
	} else {
		for _, key := range c.SupportedParams {
			if trimmed := strings.TrimSpace(key); trimmed != "" {
				params[trimmed] = struct{}{}
			}
		}
	}
	trimPrefix := strings.TrimSpace(c.TrimPrefix)
	if trimPrefix == "" {
		trimPrefix = c.Name + "/"
	}
	return openAICompatibleProvider{
		name:            c.Name,
		baseURL:         c.BaseURL,
		supportedParams: params,
		registry:        registry,
		trimPrefix:      trimPrefix,
		extraHeaders:    c.ExtraHeaders,
	}
}
