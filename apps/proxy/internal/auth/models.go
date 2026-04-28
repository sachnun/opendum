package auth

import (
	"context"
	"sort"
	"strings"

	"github.com/uptrace/bun"

	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
	"github.com/opendum/opendum/apps/proxy/internal/models"
)

func (s *Service) ValidateModel(modelParam string) ModelValidationResult {
	provider, rawModel := ParseModelParam(modelParam)
	model := s.registry.ResolveAlias(rawModel)
	if !s.registry.IsSupported(model) {
		return ModelValidationResult{Valid: false, Provider: provider, Model: rawModel, Error: "Invalid model: " + modelParam + ". Use GET /v1/models for the full list.", Param: "model", Code: "invalid_model"}
	}
	if provider != nil && !s.registry.IsSupportedByProvider(model, *provider) {
		supported := strings.Join(s.registry.ProvidersForModel(model), ", ")
		return ModelValidationResult{Valid: false, Provider: provider, Model: model, Error: "Model \"" + model + "\" is not supported by provider \"" + *provider + "\". Supported providers: " + supported, Param: "model", Code: "invalid_provider_model"}
	}
	return ModelValidationResult{Valid: true, Provider: provider, Model: model}
}

func (s *Service) ValidateModelForUser(ctx context.Context, userID, modelParam string, access ModelAccess) (ModelValidationResult, error) {
	base := s.ValidateModel(modelParam)
	if !base.Valid {
		return base, nil
	}

	disabled, err := s.IsModelDisabledForUser(ctx, userID, base.Model)
	if err != nil {
		return ModelValidationResult{}, err
	}
	if disabled {
		return ModelValidationResult{Valid: false, Provider: base.Provider, Model: base.Model, Error: "Model \"" + base.Model + "\" is disabled. Enable it from Dashboard > Models first.", Param: "model", Code: "model_disabled"}, nil
	}

	mode := normalizeAccessMode(access.Mode)
	modelSet := map[string]struct{}{}
	for _, model := range s.normalizeModelList(access.Models) {
		modelSet[model] = struct{}{}
	}
	if mode == "whitelist" {
		if _, ok := modelSet[base.Model]; !ok {
			return ModelValidationResult{Valid: false, Provider: base.Provider, Model: base.Model, Error: "Model \"" + base.Model + "\" is not allowed for this API key.", Param: "model", Code: "model_not_whitelisted"}, nil
		}
	}
	if mode == "blacklist" {
		if _, ok := modelSet[base.Model]; ok {
			return ModelValidationResult{Valid: false, Provider: base.Provider, Model: base.Model, Error: "Model \"" + base.Model + "\" is blocked for this API key.", Param: "model", Code: "model_blacklisted"}, nil
		}
	}

	return base, nil
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
	availability := AccountModelAvailability{
		ActiveProviders:              map[string]struct{}{},
		AccountCountByProvider:       map[string]int{},
		DisabledCountByProviderModel: map[string]int{},
		ActiveAccountIDsByProvider:   map[string][]string{},
		AccountTierByID:              map[string]string{},
	}

	var accounts []appdb.ProviderAccount
	if err := s.db.NewSelect().Model(&accounts).Column("id", "provider", "tier").Where("\"userId\" = ? AND \"isActive\" = TRUE", userID).Scan(ctx); err != nil {
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

	if len(accountIDs) == 0 {
		return availability, nil
	}

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

	return availability, nil
}

func (s *Service) IsModelUsableByAccounts(model string, availability AccountModelAvailability) bool {
	canonical := s.registry.ResolveAlias(model)
	for _, provider := range s.registry.ProvidersForModel(canonical) {
		total := availability.AccountCountByProvider[provider]
		if total == 0 {
			continue
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
