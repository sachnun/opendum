package providers

import (
	"strings"

	"github.com/opendum/opendum/apps/proxy/internal/models"
)

func providerConfigBool(registry *models.Registry, model, provider, key string) bool {
	value, ok := providerConfigValue(registry, model, provider, key)
	if !ok {
		return false
	}
	boolValue, _ := value.(bool)
	return boolValue
}

func providerConfigString(registry *models.Registry, model, provider, key string) string {
	value, ok := providerConfigValue(registry, model, provider, key)
	if !ok {
		return ""
	}
	text, _ := value.(string)
	return strings.TrimSpace(text)
}

func providerConfigStringMap(registry *models.Registry, model, provider, key string) map[string]string {
	value, ok := providerConfigValue(registry, model, provider, key)
	if !ok {
		return nil
	}
	rawMap, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	out := map[string]string{}
	for rawKey, rawValue := range rawMap {
		if text, ok := rawValue.(string); ok && strings.TrimSpace(text) != "" {
			out[rawKey] = strings.TrimSpace(text)
		}
	}
	return out
}

func providerConfigIntMap(registry *models.Registry, model, provider, key string) map[string]int {
	value, ok := providerConfigValue(registry, model, provider, key)
	if !ok {
		return nil
	}
	rawMap, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	out := map[string]int{}
	for rawKey, rawValue := range rawMap {
		if number := numberFromAny(rawValue); number != 0 {
			out[rawKey] = number
		}
	}
	return out
}

func providerModelConfig(registry *models.Registry, model, provider string) (models.ProviderModelConfig, bool) {
	if registry == nil {
		return models.ProviderModelConfig{}, false
	}
	cfg, ok := registry.ProviderModelConfig(model, provider)
	if !ok && provider == "antigravity" {
		if normalized := normalizeAntigravityTieredModel(model); normalized != model {
			cfg, ok = registry.ProviderModelConfig(normalized, provider)
		}
	}
	return cfg, ok
}

func providerMaxOutputTokens(registry *models.Registry, model, provider string) int {
	cfg, ok := providerModelConfig(registry, model, provider)
	if !ok {
		return 0
	}
	return cfg.MaxOutputTokens
}

func providerConfigValue(registry *models.Registry, model, provider, key string) (any, bool) {
	if provider == "antigravity" {
		return antigravityConfigValue(registry, model, key)
	}
	cfg, ok := providerModelConfig(registry, model, provider)
	if !ok || cfg.Custom == nil {
		return nil, false
	}
	value, ok := cfg.Custom[key]
	return value, ok
}

var (
	antigravityManagedKeys = []string{
		"anthropic_beta",
		"anthropic_beta_thinking",
		"convert_external_images",
		"force_stream_non_stream",
		"inject_thought_signature",
		"sanitize_tool_blocks",
		"scrub_model_artifacts",
		"signature_family",
		"strict_thought_signatures",
		"strict_tool_schema",
		"system_instruction",
		"thinking_budgets",
		"thinking_format",
		"thinking_levels",
		"thinking_model",
		"top_p_min_095",
	}
	antigravityClaudeFlags = map[string]bool{
		"anthropic_beta":            true,
		"anthropic_beta_thinking":   true,
		"convert_external_images":   true,
		"force_stream_non_stream":   true,
		"sanitize_tool_blocks":      true,
		"strict_thought_signatures": true,
		"strict_tool_schema":        true,
		"system_instruction":        true,
		"thinking_model":            true,
		"top_p_min_095":             true,
	}
	geminiThinkingLevels = map[string]any{
		"high": "high", "low": "low", "medium": "medium", "none": "minimal", "xhigh": "high",
	}
	geminiFlashThinkingBudgets = map[string]any{
		"high": 24576, "low": 6144, "medium": 12288, "xhigh": 24576,
	}
	geminiProThinkingBudgets = map[string]any{
		"high": 32768, "low": 8192, "medium": 16384, "xhigh": 32768,
	}
)

// Antigravity request shaping is fixed per model family, so it lives here
// instead of in the registry: every flag is derived from the model name.
func antigravityConfigValue(registry *models.Registry, model, key string) (any, bool) {
	name := strings.ToLower(strings.TrimSpace(normalizeAntigravityTieredModel(model)))

	if strings.HasPrefix(name, "gemini-") {
		image := strings.Contains(name, "image")
		pro := strings.Contains(name, "pro")
		levelThinking := strings.HasPrefix(name, "gemini-3") && !pro && !image

		switch key {
		case "inject_thought_signature", "scrub_model_artifacts":
			return true, true
		case "signature_family":
			return "gemini-flash", true
		case "system_instruction":
			return strings.HasPrefix(name, "gemini-3") && !image, true
		case "thinking_format":
			if image {
				return nil, false
			}
			if levelThinking {
				return "level", true
			}
			return "budget", true
		case "thinking_levels":
			if levelThinking {
				return geminiThinkingLevels, true
			}
			return nil, false
		case "thinking_budgets":
			if image || levelThinking {
				return nil, false
			}
			if pro {
				return geminiProThinkingBudgets, true
			}
			return geminiFlashThinkingBudgets, true
		}
		return nil, false
	}

	if strings.HasPrefix(name, "claude-") {
		if antigravityClaudeFlags[key] {
			return true, true
		}
		if key == "signature_family" {
			return "claude", true
		}
		return nil, false
	}

	return nil, false
}

func normalizeAntigravityTieredModel(model string) string {
	model = strings.ToLower(strings.TrimSpace(model))
	for _, suffix := range []string{"-minimal", "-low", "-medium", "-high"} {
		if strings.HasSuffix(model, suffix) {
			return strings.TrimSuffix(model, suffix)
		}
	}
	return model
}
