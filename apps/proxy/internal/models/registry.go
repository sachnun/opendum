package models

import (
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type Meta struct {
	Reasoning  *bool       `json:"reasoning"`
	ToolCall   *bool       `json:"toolCall"`
	Vision     *bool       `json:"vision"`
	Modalities *Modalities `json:"modalities"`
}

type Modalities struct {
	Input  []string `json:"input"`
	Output []string `json:"output"`
}

type ProviderAccessRule struct {
	MinTier string
}

type ProviderModelConfig struct {
	Upstream string
	MinTier  string
	Authless bool
	Aliases  []string
	Custom   map[string]any
}

type Info struct {
	Providers      []string                       `json:"providers"`
	Aliases        []string                       `json:"aliases"`
	Description    string                         `json:"description"`
	Family         string                         `json:"family"`
	Ignored        bool                           `json:"ignored"`
	Meta           *Meta                          `json:"meta"`
	ProviderConfig map[string]ProviderModelConfig `json:"providerConfig"`
}

type Registry struct {
	models             map[string]Info
	ignored            map[string]struct{}
	effective          map[string]Info
	aliasToCanonical   map[string]string
	canonicalToAliases map[string][]string
	providerModelMap   map[string]map[string]string
	providerModelSet   map[string]map[string]struct{}
}

func Load(dir string) (*Registry, error) {
	registry := &Registry{
		models:             map[string]Info{},
		ignored:            map[string]struct{}{},
		effective:          map[string]Info{},
		aliasToCanonical:   map[string]string{},
		canonicalToAliases: map[string][]string{},
		providerModelMap:   map[string]map[string]string{},
		providerModelSet:   map[string]map[string]struct{}{},
	}

	err := filepath.WalkDir(dir, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			return nil
		}

		content, err := os.ReadFile(path)
		if err != nil {
			return err
		}

		var info Info
		if err := json.Unmarshal(content, &info); err != nil {
			return err
		}

		info.Providers = compactStrings(info.Providers)
		info.Aliases = compactStrings(info.Aliases)
		modelID := strings.TrimSuffix(filepath.Base(path), ".json")
		registry.models[modelID] = info
		if info.Ignored {
			registry.ignored[modelID] = struct{}{}
		} else {
			registry.effective[modelID] = info
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	registry.buildAliases()
	return registry, nil
}

func (cfg *ProviderModelConfig) UnmarshalJSON(data []byte) error {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}

	cfg.Custom = map[string]any{}
	for key, value := range raw {
		switch key {
		case "upstream":
			var upstream string
			if err := json.Unmarshal(value, &upstream); err != nil {
				return err
			}
			cfg.Upstream = strings.TrimSpace(upstream)
		case "minTier":
			var minTier string
			if err := json.Unmarshal(value, &minTier); err != nil {
				return err
			}
			cfg.MinTier = strings.TrimSpace(minTier)
		case "authless":
			if err := json.Unmarshal(value, &cfg.Authless); err != nil {
				return err
			}
		case "aliases":
			if err := json.Unmarshal(value, &cfg.Aliases); err != nil {
				return err
			}
			cfg.Aliases = compactStrings(cfg.Aliases)
		default:
			var custom any
			if err := json.Unmarshal(value, &custom); err != nil {
				return err
			}
			cfg.Custom[key] = custom
		}
	}

	if len(cfg.Custom) == 0 {
		cfg.Custom = nil
	}
	return nil
}

func (r *Registry) buildAliases() {
	for canonical, info := range r.effective {
		for _, alias := range info.Aliases {
			r.aliasToCanonical[alias] = canonical
		}
		upstreamNames := map[string]struct{}{}
		for _, cfg := range info.ProviderConfig {
			if strings.TrimSpace(cfg.Upstream) != "" {
				upstreamNames[strings.TrimSpace(cfg.Upstream)] = struct{}{}
			}
		}
		for upstreamName := range upstreamNames {
			if _, exists := r.aliasToCanonical[upstreamName]; !exists {
				r.aliasToCanonical[upstreamName] = canonical
			}
			legacy := legacyNvidiaAlias(upstreamName)
			if legacy != upstreamName {
				if _, exists := r.aliasToCanonical[legacy]; !exists {
					r.aliasToCanonical[legacy] = canonical
				}
			}
		}
	}
	for alias, canonical := range r.aliasToCanonical {
		r.canonicalToAliases[canonical] = append(r.canonicalToAliases[canonical], alias)
	}
	for canonical := range r.canonicalToAliases {
		r.canonicalToAliases[canonical] = uniqueSorted(r.canonicalToAliases[canonical])
	}
}

func (r *Registry) ResolveAlias(model string) string {
	if canonical, ok := r.aliasToCanonical[model]; ok {
		return canonical
	}
	return model
}

func (r *Registry) LookupKeys(model string) []string {
	canonical := r.ResolveAlias(model)
	keys := append([]string{canonical}, r.canonicalToAliases[canonical]...)
	return uniqueSortedStable(keys)
}

func (r *Registry) ProvidersForModel(model string) []string {
	info, ok := r.effective[r.ResolveAlias(model)]
	if !ok {
		return nil
	}
	return append([]string(nil), info.Providers...)
}

func (r *Registry) IsSupported(model string) bool {
	return len(r.ProvidersForModel(model)) > 0
}

func (r *Registry) IsSupportedByProvider(model, provider string) bool {
	for _, item := range r.ProvidersForModel(model) {
		if item == provider {
			return true
		}
	}
	return false
}

func (r *Registry) UpstreamModelName(model, provider string) string {
	canonical := r.ResolveAlias(model)
	info, ok := r.effective[canonical]
	if !ok {
		return canonical
	}
	if upstream := info.ProviderConfig[provider].Upstream; upstream != "" {
		return upstream
	}
	return canonical
}

func (r *Registry) ProviderAccessRule(model, provider string) (ProviderAccessRule, bool) {
	info, ok := r.effective[r.ResolveAlias(model)]
	if !ok {
		return ProviderAccessRule{}, false
	}
	if minTier := info.ProviderConfig[provider].MinTier; minTier != "" {
		return ProviderAccessRule{MinTier: minTier}, true
	}
	return ProviderAccessRule{}, false
}

func (r *Registry) ProviderModelConfig(model, provider string) (ProviderModelConfig, bool) {
	info, ok := r.effective[r.ResolveAlias(model)]
	if !ok {
		return ProviderModelConfig{}, false
	}
	cfg, ok := info.ProviderConfig[provider]
	return cfg, ok
}

func (r *Registry) IsAuthlessProviderModel(model, provider string) bool {
	cfg, ok := r.ProviderModelConfig(model, provider)
	return ok && cfg.Authless
}

func (r *Registry) AuthlessProvidersForModel(model string) []string {
	canonical := r.ResolveAlias(model)
	providers := []string{}
	for _, provider := range r.ProvidersForModel(canonical) {
		if r.IsAuthlessProviderModel(canonical, provider) {
			providers = append(providers, provider)
		}
	}
	return providers
}

func (r *Registry) AuthlessProviderModels() map[string][]string {
	result := map[string][]string{}
	for model, info := range r.effective {
		for _, provider := range info.Providers {
			if r.IsAuthlessProviderModel(model, provider) {
				result[provider] = append(result[provider], model)
			}
		}
	}
	for provider := range result {
		sort.Strings(result[provider])
	}
	return result
}

func (r *Registry) ProviderModelMap(provider string) map[string]string {
	if cached, ok := r.providerModelMap[provider]; ok {
		return cached
	}
	result := map[string]string{}
	for canonical, info := range r.effective {
		if contains(info.Providers, provider) {
			upstream := canonical
			if info.ProviderConfig[provider].Upstream != "" {
				upstream = info.ProviderConfig[provider].Upstream
			}
			result[canonical] = upstream
		}
	}
	r.providerModelMap[provider] = result
	return result
}

func (r *Registry) ProviderModelSet(provider string) map[string]struct{} {
	if cached, ok := r.providerModelSet[provider]; ok {
		return cached
	}
	set := map[string]struct{}{}
	for model := range r.ProviderModelMap(provider) {
		set[model] = struct{}{}
	}
	r.providerModelSet[provider] = set
	return set
}

func (r *Registry) AllModels() []string {
	models := make([]string, 0, len(r.effective))
	for model, info := range r.effective {
		if len(info.Providers) > 0 {
			models = append(models, model)
		}
	}
	sort.Strings(models)
	return models
}

func (r *Registry) ModelInfo(model string) (Info, bool) {
	info, ok := r.effective[r.ResolveAlias(model)]
	return info, ok
}

func (r *Registry) ModelFamily(model string) string {
	info, ok := r.ModelInfo(model)
	if !ok {
		return ""
	}
	return info.Family
}

func (r *Registry) FormatModelsForOpenAI() []map[string]any {
	now := time.Now().Unix()
	data := make([]map[string]any, 0)
	for _, model := range r.AllModels() {
		info := r.effective[model]
		if len(info.Providers) == 0 {
			continue
		}
		ownedBy := strings.Join(info.Providers, ",")
		data = append(data, map[string]any{"id": model, "object": "model", "created": now, "owned_by": ownedBy})
	}
	return data
}

func (r *Registry) IsReasoningModel(model string) bool {
	return r.defaultEnabledBoolCapability(model, func(meta *Meta) *bool { return meta.Reasoning })
}

func (r *Registry) IsToolCallModel(model string) bool {
	return r.defaultEnabledBoolCapability(model, func(meta *Meta) *bool { return meta.ToolCall })
}

func (r *Registry) IsVisionModel(model string) bool {
	info, ok := r.ModelInfo(model)
	if !ok {
		return false
	}
	if info.Meta == nil {
		return true
	}
	if info.Meta.Vision != nil {
		return *info.Meta.Vision
	}
	if info.Meta.Modalities == nil {
		return true
	}
	return contains(info.Meta.Modalities.Input, "image")
}

func (r *Registry) defaultEnabledBoolCapability(model string, getCapability func(*Meta) *bool) bool {
	info, ok := r.ModelInfo(model)
	if !ok {
		return false
	}
	if info.Meta == nil {
		return true
	}
	capability := getCapability(info.Meta)
	if capability == nil {
		return true
	}
	return *capability
}

func NormalizeProviderAlias(provider string) string {
	normalized := strings.ToLower(strings.TrimSpace(provider))
	switch normalized {
	case "github-copilot", "github_copilot", "github-copilot-enterprise", "github_copilot_enterprise":
		return "copilot"
	default:
		return normalized
	}
}

func legacyNvidiaAlias(upstream string) string {
	value := strings.TrimPrefix(upstream, "library/")
	value = strings.NewReplacer(":", "-", "/", "-").Replace(value)
	var b strings.Builder
	lastDash := false
	for _, r := range value {
		valid := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '.' || r == '_' || r == '-'
		if !valid {
			r = '-'
		}
		if r == '-' {
			if lastDash {
				continue
			}
			lastDash = true
		} else {
			lastDash = false
		}
		b.WriteRune(r)
	}
	return b.String()
}

func compactStrings(values []string) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed != "" {
			result = append(result, trimmed)
		}
	}
	return result
}

func uniqueSorted(values []string) []string {
	set := map[string]struct{}{}
	for _, value := range values {
		if value != "" {
			set[value] = struct{}{}
		}
	}
	result := make([]string, 0, len(set))
	for value := range set {
		result = append(result, value)
	}
	sort.Strings(result)
	return result
}

func uniqueSortedStable(values []string) []string {
	seen := map[string]struct{}{}
	result := make([]string, 0, len(values))
	for _, value := range values {
		if _, ok := seen[value]; ok || value == "" {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}

func contains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
