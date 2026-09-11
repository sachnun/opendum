package providers

import (
	"strings"

	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
)

var defaultCustomSupportedParams = set("model", "messages", "temperature", "top_p", "max_tokens", "max_completion_tokens", "stream", "stream_options", "tools", "tool_choice", "parallel_tool_calls", "presence_penalty", "frequency_penalty", "n", "stop", "seed", "response_format", "reasoning", "reasoning_effort")

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
