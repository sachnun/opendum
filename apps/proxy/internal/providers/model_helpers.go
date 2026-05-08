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

func providerConfigValue(registry *models.Registry, model, provider, key string) (any, bool) {
	if registry == nil {
		return nil, false
	}
	cfg, ok := registry.ProviderModelConfig(model, provider)
	if !ok || cfg.Custom == nil {
		return nil, false
	}
	value, ok := cfg.Custom[key]
	return value, ok
}

func isImageGenerationModel(registry *models.Registry, model string) bool {
	if registry != nil {
		if info, ok := registry.ModelInfo(model); ok && info.Meta != nil && info.Meta.Modalities != nil {
			return containsString(info.Meta.Modalities.Output, "image")
		}
	}
	return false
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
