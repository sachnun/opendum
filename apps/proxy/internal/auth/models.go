package auth

import (
	"context"
	"sort"
	"strings"
	"time"

	"github.com/uptrace/bun"

	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
	"github.com/opendum/opendum/apps/proxy/internal/models"
)

func (s *Service) ValidateModel(modelParam string) ModelValidationResult {
	provider, rawModel := ParseModelParam(modelParam)
	model := s.registry.ResolveAlias(rawModel)
	if provider != nil && *provider == "codex" && !s.isCodexChatGPTModel(model) {
		supported := strings.Join(s.codexChatGPTModels(), ", ")
		return ModelValidationResult{Valid: false, Provider: provider, Model: model, Error: "Model \"" + rawModel + "\" is not supported for Codex when using a ChatGPT account. Use one of: " + supported + ".", Param: "model", Code: "unsupported_codex_chatgpt_model"}
	}
	if !s.registry.IsSupported(model) {
		return s.invalidModelResult(provider, rawModel, modelParam, nil)
	}
	if provider != nil && !s.registry.IsSupportedByProvider(model, *provider) {
		supported := strings.Join(s.registry.ProvidersForModel(model), ", ")
		return ModelValidationResult{Valid: false, Provider: provider, Model: model, Error: "Model \"" + model + "\" is not supported by provider \"" + *provider + "\". Supported providers: " + supported, Param: "model", Code: "invalid_provider_model"}
	}
	return ModelValidationResult{Valid: true, Provider: provider, Model: model}
}

func (s *Service) isCodexChatGPTModel(model string) bool {
	normalized := strings.ToLower(strings.TrimSpace(model))
	for canonical, upstream := range s.registry.ProviderModelMap("codex") {
		if strings.ToLower(canonical) == normalized || strings.ToLower(upstream) == normalized {
			return true
		}
	}
	return false
}

func (s *Service) codexChatGPTModels() []string {
	values := []string{}
	seen := map[string]struct{}{}
	for canonical, upstream := range s.registry.ProviderModelMap("codex") {
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

func (s *Service) ValidateModelForUser(ctx context.Context, userID, modelParam string, access ModelAccess) (ModelValidationResult, error) {
	provider, rawModel := ParseModelParam(modelParam)
	mode := normalizeAccessMode(access.Mode)
	modelSet := map[string]struct{}{}
	for _, model := range s.normalizeModelList(access.Models) {
		modelSet[model] = struct{}{}
	}
	candidates, err := s.usableModelCandidates(ctx, userID, provider, mode, modelSet, access.RoamingEnabled)
	if err != nil {
		return ModelValidationResult{}, err
	}

	base := s.ValidateModel(modelParam)
	if !base.Valid {
		if base.Code == "invalid_model" {
			return s.invalidModelResult(provider, rawModel, modelParam, candidates), nil
		}
		return base, nil
	}

	if mode == "whitelist" {
		if _, ok := modelSet[base.Model]; !ok {
			return s.invalidModelResult(base.Provider, base.Model, modelParam, candidates), nil
		}
	}
	if mode == "blacklist" {
		if _, ok := modelSet[base.Model]; ok {
			return s.invalidModelResult(base.Provider, base.Model, modelParam, candidates), nil
		}
	}

	disabled, err := s.IsModelDisabledForUser(ctx, userID, base.Model)
	if err != nil {
		return ModelValidationResult{}, err
	}
	if disabled {
		return ModelValidationResult{Valid: false, Provider: base.Provider, Model: base.Model, Error: "Model \"" + base.Model + "\" is disabled. Enable it from Dashboard > Models first.", Param: "model", Code: "model_disabled"}, nil
	}

	return base, nil
}

func (s *Service) invalidModelResult(provider *string, model, modelParam string, candidates []string) ModelValidationResult {
	suggestions := s.registry.SuggestedModels(model, provider, candidates, 5)
	suggestionMessage := " Use GET /v1/models for the full list."
	if len(suggestions) > 0 {
		suggestionMessage = " Did you mean: " + strings.Join(suggestions, ", ") + " ?"
	}
	return ModelValidationResult{Valid: false, Provider: provider, Model: model, Error: "Invalid model: " + modelParam + "." + suggestionMessage, Param: "model", Code: "invalid_model"}
}

func (s *Service) usableModelCandidates(ctx context.Context, userID string, provider *string, mode string, modelSet map[string]struct{}, roamingEnabled bool) ([]string, error) {
	candidates := s.registry.AllModels()
	if provider != nil {
		candidates = s.registry.ModelsForProvider(*provider)
	}

	// Unit tests and utility callers may construct Service without storage.
	// In the proxy server, storage is present and applies the same filters as /v1/models.
	if s.db == nil {
		return filterCandidatesByAccess(candidates, mode, modelSet), nil
	}

	disabledSet, err := s.DisabledModelSetForUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	availability, err := s.GetAccountModelAvailabilityWithSharing(ctx, userID, roamingEnabled)
	if err != nil {
		return nil, err
	}

	values := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		canonical := s.registry.ResolveAlias(candidate)
		if _, disabled := disabledSet[canonical]; disabled {
			continue
		}
		if !s.isModelUsableByAccounts(canonical, availability, roamingEnabled) {
			continue
		}
		if mode == "whitelist" {
			if _, ok := modelSet[canonical]; !ok {
				continue
			}
		}
		if mode == "blacklist" {
			if _, ok := modelSet[canonical]; ok {
				continue
			}
		}
		values = append(values, candidate)
	}
	return values, nil
}

func (s *Service) isModelUsableByAccounts(model string, availability AccountModelAvailability, includeShared bool) bool {
	if s.IsModelUsableByAccounts(model, availability) {
		return true
	}
	if !includeShared {
		return false
	}
	return s.IsModelUsableBySharedAccounts(model, availability)
}

func filterCandidatesByAccess(candidates []string, mode string, modelSet map[string]struct{}) []string {
	values := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		if mode == "whitelist" {
			if _, ok := modelSet[candidate]; !ok {
				continue
			}
		}
		if mode == "blacklist" {
			if _, ok := modelSet[candidate]; ok {
				continue
			}
		}
		values = append(values, candidate)
	}
	return values
}

func ParseModelParam(modelParam string) (*string, string) {
	index := strings.Index(modelParam, "/")
	if index < 0 {
		return nil, modelParam
	}
	provider := models.NormalizeProviderAlias(modelParam[:index])
	model := modelParam[index+1:]
	return &provider, model
}

func (s *Service) DisabledModelSetForUser(ctx context.Context, userID string) (map[string]struct{}, error) {
	if cached, ok := s.getCachedDisabledModels(ctx, userID); ok {
		return toSet(cached), nil
	}

	var rows []appdb.DisabledModel
	if err := s.db.NewSelect().Model(&rows).Column("model").Where("\"userId\" = ?", userID).Scan(ctx); err != nil {
		return nil, err
	}
	modelList := make([]string, 0, len(rows))
	for _, row := range rows {
		modelList = append(modelList, s.registry.ResolveAlias(row.Model))
	}
	modelList = s.normalizeModelList(modelList)
	_ = s.setCachedDisabledModels(ctx, userID, modelList)
	return toSet(modelList), nil
}

func (s *Service) IsModelDisabledForUser(ctx context.Context, userID, model string) (bool, error) {
	set, err := s.DisabledModelSetForUser(ctx, userID)
	if err != nil {
		return false, err
	}
	_, ok := set[s.registry.ResolveAlias(model)]
	return ok, nil
}

func (s *Service) GetAccountModelAvailability(ctx context.Context, userID string) (AccountModelAvailability, error) {
	return s.GetAccountModelAvailabilityWithSharing(ctx, userID, false)
}

func (s *Service) GetAccountModelAvailabilityWithSharing(ctx context.Context, userID string, includeShared bool) (AccountModelAvailability, error) {
	availability := AccountModelAvailability{
		ActiveProviders:                    map[string]struct{}{},
		AccountCountByProvider:             map[string]int{},
		DisabledCountByProviderModel:       map[string]int{},
		ActiveAccountIDsByProvider:         map[string][]string{},
		AccountTierByID:                    map[string]string{},
		AuthlessProviderModels:             map[string]map[string]struct{}{},
		SharedAccountCountByProvider:       map[string]int{},
		SharedDisabledCountByProviderModel: map[string]int{},
		SharedAccountTiersByProvider:       map[string][]string{},
	}
	for _, provider := range authlessProviderNames {
		availability.ActiveProviders[provider] = struct{}{}
		availability.AccountCountByProvider[provider] = 1
		availability.ActiveAccountIDsByProvider[provider] = []string{provider}
	}
	for provider, models := range s.registry.AuthlessProviderModels() {
		if len(models) == 0 {
			continue
		}
		availability.ActiveProviders[provider] = struct{}{}
		availability.AccountCountByProvider[provider] = 1
		availability.ActiveAccountIDsByProvider[provider] = []string{provider}
		if availability.AuthlessProviderModels[provider] == nil {
			availability.AuthlessProviderModels[provider] = map[string]struct{}{}
		}
		for _, model := range models {
			availability.AuthlessProviderModels[provider][model] = struct{}{}
		}
	}

	var accounts []appdb.ProviderAccount
	if err := s.db.NewSelect().Model(&accounts).Column("id", "provider", "tier").Where("\"userId\" = ? AND \"isActive\" = TRUE", userID).Where("(\"disabledUntil\" IS NULL OR \"disabledUntil\" <= ?)", time.Now()).Scan(ctx); err != nil {
		return availability, err
	}

	accountProvider := map[string]string{}
	accountIDs := make([]string, 0, len(accounts))
	for _, account := range accounts {
		availability.ActiveProviders[account.Provider] = struct{}{}
		availability.AccountCountByProvider[account.Provider]++
		availability.ActiveAccountIDsByProvider[account.Provider] = append(availability.ActiveAccountIDsByProvider[account.Provider], account.ID)
		accountProvider[account.ID] = account.Provider
		accountIDs = append(accountIDs, account.ID)
		if account.Tier != nil && strings.TrimSpace(*account.Tier) != "" {
			availability.AccountTierByID[account.ID] = strings.ToLower(strings.TrimSpace(*account.Tier))
		}
	}

	if len(accountIDs) > 0 {
		var disabledRows []appdb.ProviderAccountDisabledModel
		if err := s.db.NewSelect().Model(&disabledRows).Column("providerAccountId", "model").Where("\"providerAccountId\" IN (?)", bun.In(accountIDs)).Scan(ctx); err != nil {
			return availability, err
		}
		for _, row := range disabledRows {
			provider := accountProvider[row.ProviderAccountID]
			if provider == "" {
				continue
			}
			key := provider + ":" + s.registry.ResolveAlias(row.Model)
			availability.DisabledCountByProviderModel[key]++
		}
	}

	if !includeShared {
		return availability, nil
	}

	var sharedAccounts []appdb.ProviderAccount
	if err := s.db.NewSelect().Model((*appdb.ProviderAccount)(nil)).Column("provider_account.id", "provider_account.provider", "provider_account.tier").Join("JOIN user_sharing_setting ON user_sharing_setting.\"userId\" = provider_account.\"userId\"").Where("provider_account.\"userId\" != ?", userID).Where("user_sharing_setting.enabled = TRUE").Where("provider_account.\"isActive\" = TRUE").Where("(provider_account.\"disabledUntil\" IS NULL OR provider_account.\"disabledUntil\" <= ?)", time.Now()).Scan(ctx, &sharedAccounts); err != nil {
		return availability, err
	}
	sharedAccountProvider := map[string]string{}
	sharedAccountIDs := make([]string, 0, len(sharedAccounts))
	for _, account := range sharedAccounts {
		availability.SharedAccountCountByProvider[account.Provider]++
		sharedAccountProvider[account.ID] = account.Provider
		sharedAccountIDs = append(sharedAccountIDs, account.ID)
		if account.Tier != nil && strings.TrimSpace(*account.Tier) != "" {
			availability.SharedAccountTiersByProvider[account.Provider] = append(availability.SharedAccountTiersByProvider[account.Provider], strings.ToLower(strings.TrimSpace(*account.Tier)))
		}
	}
	if len(sharedAccountIDs) > 0 {
		var sharedDisabledRows []appdb.ProviderAccountDisabledModel
		if err := s.db.NewSelect().Model(&sharedDisabledRows).Column("providerAccountId", "model").Where("\"providerAccountId\" IN (?)", bun.In(sharedAccountIDs)).Scan(ctx); err != nil {
			return availability, err
		}
		for _, row := range sharedDisabledRows {
			provider := sharedAccountProvider[row.ProviderAccountID]
			if provider == "" {
				continue
			}
			key := provider + ":" + s.registry.ResolveAlias(row.Model)
			availability.SharedDisabledCountByProviderModel[key]++
		}
	}

	return availability, nil
}

func (s *Service) IsModelUsableByAccounts(model string, availability AccountModelAvailability) bool {
	canonical := s.registry.ResolveAlias(model)
	for _, provider := range s.registry.ProvidersForModel(canonical) {
		total := availability.AccountCountByProvider[provider]
		if total == 0 {
			continue
		}
		if authlessModels := availability.AuthlessProviderModels[provider]; len(authlessModels) > 0 {
			if _, ok := authlessModels[canonical]; !ok {
				if total == 1 {
					continue
				}
				total--
			}
		}
		if rule, ok := s.registry.ProviderAccessRule(canonical, provider); ok && rule.MinTier != "" {
			eligible := false
			for _, accountID := range availability.ActiveAccountIDsByProvider[provider] {
				if tierSatisfies(availability.AccountTierByID[accountID], rule.MinTier) {
					eligible = true
					break
				}
			}
			if !eligible {
				continue
			}
		}
		if availability.DisabledCountByProviderModel[provider+":"+canonical] < total {
			return true
		}
	}
	return false
}

func (s *Service) IsModelUsableBySharedAccounts(model string, availability AccountModelAvailability) bool {
	canonical := s.registry.ResolveAlias(model)
	for _, provider := range s.registry.ProvidersForModel(canonical) {
		total := availability.SharedAccountCountByProvider[provider]
		if total == 0 {
			continue
		}
		if rule, ok := s.registry.ProviderAccessRule(canonical, provider); ok && rule.MinTier != "" {
			eligible := false
			for _, tier := range availability.SharedAccountTiersByProvider[provider] {
				if tierSatisfies(tier, rule.MinTier) {
					eligible = true
					break
				}
			}
			if !eligible {
				continue
			}
		}
		if availability.SharedDisabledCountByProviderModel[provider+":"+canonical] < total {
			return true
		}
	}
	return false
}

func (s *Service) normalizeModelList(values []string) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			continue
		}
		model := s.registry.ResolveAlias(trimmed)
		if s.registry.IsSupported(model) {
			result = append(result, model)
		}
	}
	return uniqueSorted(result)
}

func normalizeAccessMode(mode string) string {
	if mode == "whitelist" || mode == "blacklist" {
		return mode
	}
	return "all"
}

func normalizeAccountList(values []string) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed != "" {
			result = append(result, trimmed)
		}
	}
	return uniqueSorted(result)
}

func toSet(values []string) map[string]struct{} {
	set := map[string]struct{}{}
	for _, value := range values {
		set[value] = struct{}{}
	}
	return set
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

func tierSatisfies(accountTier, minTier string) bool {
	required := strings.ToLower(strings.TrimSpace(minTier))
	if required == "" || required == "free" {
		return true
	}
	return strings.ToLower(strings.TrimSpace(accountTier)) == required
}

func defaultString(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}
