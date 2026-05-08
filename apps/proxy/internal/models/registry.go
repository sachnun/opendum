package models

import (
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/pelletier/go-toml/v2"
)

type Meta struct {
	ContextLength   *int
	OutputLimit     *int
	KnowledgeCutoff *string
	ReleaseDate     *string
	Reasoning       *bool
	ToolCall        *bool
	Vision          *bool
	Modalities      *Modalities
}

type Modalities struct {
	Input  []string `toml:"input"`
	Output []string `toml:"output"`
}

type ProviderAccessRule struct {
	MinTier string
}

type ProviderModelConfig struct {
	Upstream string
	MinTier  string
	Aliases  []string
	Custom   map[string]any
}

type Info struct {
	Providers      []string
	Aliases        []string
	Description    string
	Family         string
	Meta           *Meta
	Upstream       map[string]string
	Access         map[string]ProviderAccessRule
	ProviderConfig map[string]ProviderModelConfig
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

type rawModel struct {
	ReleaseDate string      `toml:"release_date"`
	Knowledge   string      `toml:"knowledge"`
	Reasoning   *bool       `toml:"reasoning"`
	ToolCall    *bool       `toml:"tool_call"`
	Attachment  *bool       `toml:"attachment"`
	Limit       rawLimit    `toml:"limit"`
	Modalities  *Modalities `toml:"modalities"`
	Opendum     rawOpendum  `toml:"opendum"`
	Extra       map[string]ProviderModelConfig
}

type rawLimit struct {
	Context *int `toml:"context"`
	Output  *int `toml:"output"`
}

type rawOpendum struct {
	Family      string                           `toml:"family"`
	Providers   []string                         `toml:"providers"`
	Aliases     []string                         `toml:"aliases"`
	Ignored     bool                             `toml:"ignored"`
	Description string                           `toml:"description"`
	Upstream    map[string]string                `toml:"upstream"`
	Access      map[string]rawProviderAccessRule `toml:"access"`
}

type rawProviderAccessRule struct {
	MinTier string `toml:"min_tier"`
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
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".toml") {
			return nil
		}

		content, err := os.ReadFile(path)
		if err != nil {
			return err
		}

		var raw map[string]any
		if err := toml.Unmarshal(content, &raw); err != nil {
			return err
		}
		var parsed rawModel
		if err := toml.Unmarshal(content, &parsed); err != nil {
			return err
		}

		modelID := strings.TrimSuffix(filepath.Base(path), ".toml")
		info := convertRawModel(parsed, raw)
		registry.models[modelID] = info
		if parsed.Opendum.Ignored {
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

func convertRawModel(parsed rawModel, raw map[string]any) Info {
	providerConfig := map[string]ProviderModelConfig{}
	reserved := map[string]struct{}{"limit": {}, "modalities": {}, "opendum": {}}
	for key := range raw {
		if _, ok := reserved[key]; ok {
			continue
		}
		cfg := providerModelConfigFromRaw(raw[key])
		if cfg.Upstream != "" || cfg.MinTier != "" || len(cfg.Aliases) > 0 || len(cfg.Custom) > 0 {
			providerConfig[key] = cfg
		}
	}

	upstream := map[string]string{}
	for key, value := range parsed.Opendum.Upstream {
		if strings.TrimSpace(value) != "" {
			upstream[key] = strings.TrimSpace(value)
		}
	}
	for provider, cfg := range providerConfig {
		if strings.TrimSpace(cfg.Upstream) != "" {
			upstream[provider] = strings.TrimSpace(cfg.Upstream)
		}
	}

	access := map[string]ProviderAccessRule{}
	for provider, rule := range parsed.Opendum.Access {
		if strings.TrimSpace(rule.MinTier) != "" {
			access[provider] = ProviderAccessRule{MinTier: strings.TrimSpace(rule.MinTier)}
		}
	}
	for provider, cfg := range providerConfig {
		if strings.TrimSpace(cfg.MinTier) != "" {
			access[provider] = ProviderAccessRule{MinTier: strings.TrimSpace(cfg.MinTier)}
		}
	}

	var meta *Meta
	if parsed.ReleaseDate != "" || parsed.Knowledge != "" || parsed.Reasoning != nil || parsed.ToolCall != nil || parsed.Attachment != nil || parsed.Limit.Context != nil || parsed.Limit.Output != nil || parsed.Modalities != nil {
		meta = &Meta{
			ContextLength: parsed.Limit.Context,
			OutputLimit:   parsed.Limit.Output,
			Reasoning:     parsed.Reasoning,
			ToolCall:      parsed.ToolCall,
			Vision:        parsed.Attachment,
			Modalities:    parsed.Modalities,
		}
		if parsed.Knowledge != "" {
			meta.KnowledgeCutoff = &parsed.Knowledge
		}
		if parsed.ReleaseDate != "" {
			meta.ReleaseDate = &parsed.ReleaseDate
		}
	}

	return Info{
		Providers:      compactStrings(parsed.Opendum.Providers),
		Aliases:        compactStrings(parsed.Opendum.Aliases),
		Description:    parsed.Opendum.Description,
		Family:         parsed.Opendum.Family,
		Meta:           meta,
		Upstream:       upstream,
		Access:         access,
		ProviderConfig: providerConfig,
	}
}

func providerModelConfigFromRaw(value any) ProviderModelConfig {
	table, ok := value.(map[string]any)
	if !ok {
		return ProviderModelConfig{}
	}
	cfg := ProviderModelConfig{Custom: map[string]any{}}
	for key, raw := range table {
		switch key {
		case "upstream":
			cfg.Upstream = strings.TrimSpace(stringFromRaw(raw))
		case "min_tier":
			cfg.MinTier = strings.TrimSpace(stringFromRaw(raw))
		case "aliases":
			cfg.Aliases = stringSliceFromRaw(raw)
		default:
			cfg.Custom[key] = raw
		}
	}
	if len(cfg.Custom) == 0 {
		cfg.Custom = nil
	}
	return cfg
}

func stringFromRaw(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	return ""
}

func stringSliceFromRaw(value any) []string {
	items, ok := value.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		if text := strings.TrimSpace(stringFromRaw(item)); text != "" {
			out = append(out, text)
		}
	}
	return out
}

func (r *Registry) buildAliases() {
	for canonical, info := range r.effective {
		for _, alias := range info.Aliases {
			r.aliasToCanonical[alias] = canonical
		}
		for _, upstreamName := range info.Upstream {
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
	if upstream := info.Upstream[provider]; upstream != "" {
		return upstream
	}
	return canonical
}

func (r *Registry) ProviderAccessRule(model, provider string) (ProviderAccessRule, bool) {
	info, ok := r.effective[r.ResolveAlias(model)]
	if !ok {
		return ProviderAccessRule{}, false
	}
	rule, ok := info.Access[provider]
	return rule, ok
}

func (r *Registry) ProviderModelConfig(model, provider string) (ProviderModelConfig, bool) {
	info, ok := r.effective[r.ResolveAlias(model)]
	if !ok {
		return ProviderModelConfig{}, false
	}
	cfg, ok := info.ProviderConfig[provider]
	return cfg, ok
}

func (r *Registry) ProviderModelMap(provider string) map[string]string {
	if cached, ok := r.providerModelMap[provider]; ok {
		return cached
	}
	result := map[string]string{}
	for canonical, info := range r.effective {
		if contains(info.Providers, provider) {
			upstream := canonical
			if info.Upstream[provider] != "" {
				upstream = info.Upstream[provider]
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

func (r *Registry) IsVisionModel(model string) bool {
	info, ok := r.ModelInfo(model)
	if !ok || info.Meta == nil {
		return false
	}
	if info.Meta.Vision != nil && *info.Meta.Vision {
		return true
	}
	if info.Meta.Modalities != nil {
		return contains(info.Meta.Modalities.Input, "image")
	}
	return false
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
