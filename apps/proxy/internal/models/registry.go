package models

import (
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode"
)

const suggestionThreshold = 0.7

type Meta struct {
	Reasoning *bool `json:"reasoning"`
	ToolCall  *bool `json:"toolCall"`
	Vision    *bool `json:"vision"`
}

type ProviderAccessRule struct {
	MinTier      string
	AllowedTiers []string
}

type ProviderModelConfig struct {
	Upstream     string
	MinTier      string
	AllowedTiers []string
	Authless     bool
	Aliases      []string
	Custom       map[string]any
}

type Info struct {
	ID             string                         `json:"id"`
	Providers      []string                       `json:"providers"`
	Aliases        []string                       `json:"aliases"`
	Description    string                         `json:"description"`
	Family         string                         `json:"family"`
	Ignored        bool                           `json:"ignored"`
	Meta           *Meta                          `json:"meta"`
	ProviderConfig map[string]ProviderModelConfig `json:"providerConfig"`
}

type Registry struct {
	models              map[string]Info
	ignored             map[string]struct{}
	effective           map[string]Info
	aliasToCanonical    map[string]string
	canonicalToAliases  map[string][]string
	providerModelMap    map[string]map[string]string
	providerModelSet    map[string]map[string]struct{}
	suggestionModels    []suggestionCandidate
	suggestionProviders map[string][]suggestionCandidate
}

type suggestionCandidate struct {
	Value      string
	Normalized string
	Tokens     []string
}

func Load(dir string) (*Registry, error) {
	registry := &Registry{
		models:              map[string]Info{},
		ignored:             map[string]struct{}{},
		effective:           map[string]Info{},
		aliasToCanonical:    map[string]string{},
		canonicalToAliases:  map[string][]string{},
		providerModelMap:    map[string]map[string]string{},
		providerModelSet:    map[string]map[string]struct{}{},
		suggestionProviders: map[string][]suggestionCandidate{},
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

		info.ID = strings.TrimSpace(info.ID)
		info.Providers = compactStrings(info.Providers)
		info.Aliases = compactStrings(info.Aliases)
		fileID := strings.TrimSuffix(filepath.Base(path), ".json")
		modelID := fileID
		if info.ID != "" {
			modelID = info.ID
		}
		registry.mergeModelInfo(modelID, fileID, info)
		if info.Ignored {
			registry.ignored[modelID] = struct{}{}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	registry.buildAliases()
	registry.buildSuggestionCandidates()
	return registry, nil
}

func (r *Registry) mergeModelInfo(modelID, fileID string, info Info) {
	if info.ID == "" {
		info.ID = modelID
	}
	if fileID != modelID {
		info.Aliases = append(info.Aliases, fileID)
	}

	existing, exists := r.models[modelID]
	if !exists {
		info.Aliases = uniqueSorted(info.Aliases)
		r.models[modelID] = info
		if !info.Ignored {
			r.effective[modelID] = info
		}
		return
	}

	merged := existing
	merged.ID = modelID
	merged.Providers = uniqueSorted(append(merged.Providers, info.Providers...))
	merged.Aliases = uniqueSorted(append(merged.Aliases, info.Aliases...))
	if merged.Description == "" {
		merged.Description = info.Description
	}
	if merged.Family == "" {
		merged.Family = info.Family
	}
	merged.Ignored = merged.Ignored && info.Ignored
	if merged.Meta == nil {
		merged.Meta = info.Meta
	}
	if len(info.ProviderConfig) > 0 {
		if merged.ProviderConfig == nil {
			merged.ProviderConfig = map[string]ProviderModelConfig{}
		}
		for provider, cfg := range info.ProviderConfig {
			merged.ProviderConfig[provider] = cfg
		}
	}

	r.models[modelID] = merged
	if !merged.Ignored {
		r.effective[modelID] = merged
	} else {
		delete(r.effective, modelID)
	}
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
		case "allowedTiers":
			if err := json.Unmarshal(value, &cfg.AllowedTiers); err != nil {
				return err
			}
			cfg.AllowedTiers = compactStrings(cfg.AllowedTiers)
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
		if info.ID != "" && info.ID != canonical {
			r.aliasToCanonical[info.ID] = canonical
		}
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

func (r *Registry) buildSuggestionCandidates() {
	for _, model := range r.AllModels() {
		candidate := newSuggestionCandidate(model)
		r.suggestionModels = append(r.suggestionModels, candidate)
		info := r.effective[model]
		for _, provider := range info.Providers {
			r.suggestionProviders[provider] = append(r.suggestionProviders[provider], candidate)
		}
	}
	for provider := range r.suggestionProviders {
		sort.Slice(r.suggestionProviders[provider], func(i, j int) bool {
			return r.suggestionProviders[provider][i].Value < r.suggestionProviders[provider][j].Value
		})
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
	cfg := info.ProviderConfig[provider]
	if cfg.MinTier != "" || len(cfg.AllowedTiers) > 0 {
		return ProviderAccessRule{MinTier: cfg.MinTier, AllowedTiers: append([]string(nil), cfg.AllowedTiers...)}, true
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

func (r *Registry) ModelsForProvider(provider string) []string {
	values := []string{}
	for model, info := range r.effective {
		if !contains(info.Providers, provider) {
			continue
		}
		values = append(values, model)
	}
	return uniqueSorted(values)
}

func (r *Registry) SuggestedModels(model string, provider *string, candidates []string, limit int) []string {
	term := strings.TrimSpace(model)
	if term == "" || limit <= 0 {
		return nil
	}
	query := newSuggestionCandidate(term)

	useProviderPrefix := false
	suggestionCandidates := []suggestionCandidate{}
	if candidates == nil {
		if provider != nil {
			providerCandidates := r.suggestionProviders[*provider]
			if len(providerCandidates) > 0 {
				suggestionCandidates = providerCandidates
				useProviderPrefix = true
			}
		}
		if len(suggestionCandidates) == 0 {
			suggestionCandidates = r.suggestionModels
		}
	} else {
		candidates = uniqueSorted(candidates)
		for _, candidate := range candidates {
			suggestionCandidates = append(suggestionCandidates, newSuggestionCandidate(candidate))
		}
		useProviderPrefix = provider != nil
	}

	type match struct {
		value string
		score float64
	}
	matches := []match{}
	for _, candidate := range suggestionCandidates {
		score := suggestionScore(query, candidate)
		if score >= suggestionThreshold {
			matches = append(matches, match{value: candidate.Value, score: score})
		}
	}
	sort.Slice(matches, func(i, j int) bool {
		if matches[i].score == matches[j].score {
			return matches[i].value < matches[j].value
		}
		return matches[i].score > matches[j].score
	})

	result := []string{}
	seen := map[string]struct{}{}
	for _, item := range matches {
		value := item.value
		if useProviderPrefix && provider != nil {
			value = *provider + "/" + value
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
		if len(result) >= limit {
			break
		}
	}
	return result
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
	return r.defaultEnabledBoolCapability(model, func(meta *Meta) *bool { return meta.Vision })
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

func newSuggestionCandidate(value string) suggestionCandidate {
	normalized := normalizeSuggestionValue(value)
	return suggestionCandidate{Value: value, Normalized: normalized, Tokens: strings.Fields(normalized)}
}

func suggestionScore(term, candidate suggestionCandidate) float64 {
	left := term.Normalized
	right := candidate.Normalized
	if left == "" || right == "" {
		return 0
	}
	if left == right {
		return 1
	}
	if strings.Contains(right, left) || strings.Contains(left, right) {
		shorter := len([]rune(left))
		longer := len([]rune(right))
		if len([]rune(right)) < shorter {
			shorter = len([]rune(right))
			longer = len([]rune(left))
		}
		return 0.8 + 0.2*(float64(shorter)/float64(longer))
	}
	if score := tokenSuggestionScore(term.Tokens, candidate.Tokens); score > 0 {
		return score
	}
	maxLen := len([]rune(left))
	if otherLen := len([]rune(right)); otherLen > maxLen {
		maxLen = otherLen
	}
	if maxLen == 0 {
		return 0
	}
	distance := levenshteinDistance(left, right)
	return 1 - float64(distance)/float64(maxLen)
}

func tokenSuggestionScore(termTokens, candidateTokens []string) float64 {
	if len(termTokens) == 0 || len(candidateTokens) == 0 {
		return 0
	}

	total := 0.0
	for _, token := range termTokens {
		best := 0.0
		for _, candidateToken := range candidateTokens {
			score := compactTokenScore(token, candidateToken)
			if score > best {
				best = score
			}
		}
		total += best
	}

	return total / float64(len(termTokens))
}

func compactTokenScore(term, candidate string) float64 {
	if term == candidate {
		return 1
	}
	if strings.Contains(candidate, term) || strings.Contains(term, candidate) {
		shorter := len([]rune(term))
		longer := len([]rune(candidate))
		if len([]rune(candidate)) < shorter {
			shorter = len([]rune(candidate))
			longer = len([]rune(term))
		}
		return 0.82 + 0.18*(float64(shorter)/float64(longer))
	}
	maxLen := len([]rune(term))
	if otherLen := len([]rune(candidate)); otherLen > maxLen {
		maxLen = otherLen
	}
	if maxLen == 0 {
		return 0
	}
	distance := levenshteinDistance(term, candidate)
	score := 1 - float64(distance)/float64(maxLen)
	if score < 0 {
		return 0
	}
	return score
}

func normalizeSuggestionValue(value string) string {
	var b strings.Builder
	lastSeparator := false
	for _, r := range strings.ToLower(strings.TrimSpace(value)) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
			lastSeparator = false
			continue
		}
		if !lastSeparator {
			b.WriteRune(' ')
			lastSeparator = true
		}
	}
	return strings.TrimSpace(b.String())
}

func levenshteinDistance(a, b string) int {
	left := []rune(a)
	right := []rune(b)
	if len(left) == 0 {
		return len(right)
	}
	if len(right) == 0 {
		return len(left)
	}
	previous := make([]int, len(right)+1)
	current := make([]int, len(right)+1)
	for j := range previous {
		previous[j] = j
	}
	for i, l := range left {
		current[0] = i + 1
		for j, r := range right {
			cost := 0
			if l != r {
				cost = 1
			}
			current[j+1] = minInt(current[j]+1, previous[j+1]+1, previous[j]+cost)
		}
		previous, current = current, previous
	}
	return previous[len(right)]
}

func minInt(values ...int) int {
	min := values[0]
	for _, value := range values[1:] {
		if value < min {
			min = value
		}
	}
	return min
}
