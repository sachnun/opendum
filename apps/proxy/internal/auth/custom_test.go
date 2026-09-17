package auth

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/opendum/opendum/apps/proxy/internal/db"
	"github.com/opendum/opendum/apps/proxy/internal/models"
	"github.com/opendum/opendum/apps/proxy/internal/providers"
)

type fakeCustomProviderReader struct {
	providers  []db.CustomProvider
	modelsByID map[string][]db.CustomProviderModel
}

func (f *fakeCustomProviderReader) ListProviders(ctx context.Context, userID string) ([]db.CustomProvider, error) {
	result := []db.CustomProvider{}
	for _, provider := range f.providers {
		if provider.UserID == userID {
			result = append(result, provider)
		}
	}
	return result, nil
}

func (f *fakeCustomProviderReader) GetProvider(ctx context.Context, userID, slug string) (*db.CustomProvider, error) {
	for i := range f.providers {
		if f.providers[i].UserID == userID && f.providers[i].Slug == slug {
			return &f.providers[i], nil
		}
	}
	return nil, nil
}

func (f *fakeCustomProviderReader) ListModels(ctx context.Context, providerID string) ([]db.CustomProviderModel, error) {
	return f.modelsByID[providerID], nil
}

func customValidationService(t *testing.T) *Service {
	t.Helper()
	registry, err := models.Load(filepath.Join("..", "..", "..", "..", "packages", "models", "data"))
	if err != nil {
		t.Fatalf("load registry: %v", err)
	}
	provider := db.CustomProvider{ID: "prov_1", UserID: "u1", Slug: "my-vllm", BaseURL: "https://vllm.internal/v1", Enabled: true}
	qwenUpstream := "Qwen/Qwen3-32B"
	localUpstream := "local/my-local-vlm"
	claudeUpstream := "claude-sonnet-4-6"
	geminiUpstream := "google/gemini-2.5-flash"
	rows := []db.CustomProviderModel{
		{ID: "m_1", ProviderID: "prov_1", ModelID: "qwen3-32b", Upstream: &qwenUpstream, Aliased: true},
		{ID: "m_2", ProviderID: "prov_1", ModelID: "my-local-vlm", Upstream: &localUpstream},
		{ID: "m_3", ProviderID: "prov_1", ModelID: "claude-sonnet-4-6", Upstream: &claudeUpstream},
		{ID: "m_4", ProviderID: "prov_1", ModelID: "gemini-2.5-flash", Upstream: &geminiUpstream},
	}
	reader := &fakeCustomProviderReader{
		providers:  []db.CustomProvider{provider},
		modelsByID: map[string][]db.CustomProviderModel{"prov_1": rows},
	}
	return &Service{registry: registry, customProviders: reader}
}

func TestValidateModelForUserAcceptsOwnedCustomModel(t *testing.T) {
	service := customValidationService(t)
	result, err := service.ValidateModelForUser(context.Background(), "u1", "my-vllm/qwen3-32b", ModelAccess{})
	if err != nil {
		t.Fatalf("ValidateModelForUser error = %v", err)
	}
	if !result.Valid {
		t.Fatalf("result = %+v, want valid", result)
	}
	if result.Provider == nil || *result.Provider != "my-vllm" {
		t.Fatalf("Provider = %v, want my-vllm", result.Provider)
	}
	if result.Model != "my-vllm/qwen3-32b" {
		t.Fatalf("Model = %q, want my-vllm/qwen3-32b", result.Model)
	}
	if result.Vision == nil || *result.Vision {
		t.Fatalf("Vision = %v, want false for text-only built-in alias", result.Vision)
	}
}

func TestValidateModelForUserTreatsUnknownCustomModelAsSupported(t *testing.T) {
	service := customValidationService(t)
	result, err := service.ValidateModelForUser(context.Background(), "u1", "my-vllm/my-local-vlm", ModelAccess{})
	if err != nil {
		t.Fatalf("ValidateModelForUser error = %v", err)
	}
	if !result.Valid {
		t.Fatalf("result = %+v, want valid", result)
	}
	if result.Vision == nil || !*result.Vision {
		t.Fatalf("Vision = %v, want true for unknown custom model", result.Vision)
	}
}

func TestValidateModelForUserRejectsUnregisteredCustomModel(t *testing.T) {
	service := customValidationService(t)
	result, err := service.ValidateModelForUser(context.Background(), "u1", "my-vllm/nope-model", ModelAccess{})
	if err != nil {
		t.Fatalf("ValidateModelForUser error = %v", err)
	}
	if result.Valid {
		t.Fatalf("result = %+v, want invalid", result)
	}
	if result.Code != "invalid_model" {
		t.Fatalf("Code = %q, want invalid_model", result.Code)
	}
}

func TestValidateModelForUserRejectsForeignCustomSlug(t *testing.T) {
	service := customValidationService(t)
	result, err := service.ValidateModelForUser(context.Background(), "u2", "my-vllm/qwen3-32b", ModelAccess{})
	if err != nil {
		t.Fatalf("ValidateModelForUser error = %v", err)
	}
	if result.Valid {
		t.Fatalf("result = %+v, want invalid for non-owner", result)
	}
}

func TestValidateModelForUserCustomStoreNil(t *testing.T) {
	registry, err := models.Load(filepath.Join("..", "..", "..", "..", "packages", "models", "data"))
	if err != nil {
		t.Fatalf("load registry: %v", err)
	}
	service := NewService(nil, nil, registry)
	result, err := service.ValidateModelForUser(context.Background(), "u1", "my-vllm/qwen3-32b", ModelAccess{})
	if err != nil {
		t.Fatalf("ValidateModelForUser error = %v", err)
	}
	if result.Valid {
		t.Fatalf("result = %+v, want invalid without store", result)
	}
}

func TestValidateModelForUserCustomModelRespectsWhitelist(t *testing.T) {
	service := customValidationService(t)
	result, err := service.ValidateModelForUser(context.Background(), "u1", "my-vllm/qwen3-32b", ModelAccess{Mode: "whitelist", Models: []string{"claude-sonnet-4-6"}})
	if err != nil {
		t.Fatalf("ValidateModelForUser error = %v", err)
	}
	if result.Valid {
		t.Fatalf("result = %+v, want invalid: custom model not in whitelist", result)
	}
}

func TestValidateModelForUserCustomModelRespectsBlacklist(t *testing.T) {
	service := customValidationService(t)
	result, err := service.ValidateModelForUser(context.Background(), "u1", "my-vllm/qwen3-32b", ModelAccess{Mode: "blacklist", Models: []string{"my-vllm/qwen3-32b"}})
	if err != nil {
		t.Fatalf("ValidateModelForUser error = %v", err)
	}
	if result.Valid {
		t.Fatalf("result = %+v, want invalid: custom model blacklisted", result)
	}
}

func TestValidateModelForUserCustomAliasRespectsCanonicalAccess(t *testing.T) {
	service := customValidationService(t)
	canonical := service.registry.ResolveAlias("qwen3-32b")
	if !service.registry.IsSupported(canonical) {
		t.Fatalf("fixture alias %q does not resolve to a supported model", canonical)
	}
	whitelisted, err := service.ValidateModelForUser(context.Background(), "u1", "my-vllm/qwen3-32b", ModelAccess{Mode: "whitelist", Models: []string{canonical}})
	if err != nil {
		t.Fatalf("ValidateModelForUser error = %v", err)
	}
	if !whitelisted.Valid {
		t.Fatalf("result = %+v, want valid via canonical whitelist", whitelisted)
	}
	blacklisted, err := service.ValidateModelForUser(context.Background(), "u1", "my-vllm/qwen3-32b", ModelAccess{Mode: "blacklist", Models: []string{canonical}})
	if err != nil {
		t.Fatalf("ValidateModelForUser error = %v", err)
	}
	if blacklisted.Valid {
		t.Fatalf("result = %+v, want invalid via canonical blacklist", blacklisted)
	}
}

func TestValidateModelForUserAllowsWhitelistedStandaloneCustomModel(t *testing.T) {
	service := customValidationService(t)
	result, err := service.ValidateModelForUser(context.Background(), "u1", "my-vllm/my-local-vlm", ModelAccess{Mode: "whitelist", Models: []string{"my-vllm/my-local-vlm"}})
	if err != nil {
		t.Fatalf("ValidateModelForUser error = %v", err)
	}
	if !result.Valid {
		t.Fatalf("result = %+v, want valid: standalone custom model whitelisted", result)
	}
}

func TestNormalizeModelAccessListKeepsCustomIDs(t *testing.T) {
	service := customValidationService(t)
	got := service.normalizeModelAccessList([]string{" claude-sonnet-4-6 ", "my-vllm/my-local-vlm", ""})
	want := []string{"claude-sonnet-4-6", "my-vllm/my-local-vlm"}
	if len(got) != len(want) {
		t.Fatalf("normalizeModelAccessList = %v, want %v", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("normalizeModelAccessList = %v, want %v", got, want)
		}
	}
}

func TestListUserCustomModelsSkipsAliasedModels(t *testing.T) {
	service := customValidationService(t)
	items, err := service.ListUserCustomModels(context.Background(), "u1")
	if err != nil {
		t.Fatalf("ListUserCustomModels error = %v", err)
	}
	got := map[string]bool{}
	for _, item := range items {
		id, _ := item["id"].(string)
		got[id] = true
	}
	if !got["my-vllm/my-local-vlm"] || !got["my-vllm/claude-sonnet-4-6"] || !got["my-vllm/gemini-2.5-flash"] {
		t.Fatalf("items = %+v, want standalone models", items)
	}
	if len(items) != 3 {
		t.Fatalf("items = %+v, want only standalone models", items)
	}
}

func TestValidateModelForUserAliasNotSetStaysStandalone(t *testing.T) {
	service := customValidationService(t)
	result, err := service.ValidateModelForUser(context.Background(), "u1", "my-vllm/gemini-2.5-flash", ModelAccess{Mode: "whitelist", Models: []string{"gemini-2.5-flash"}})
	if err != nil {
		t.Fatalf("ValidateModelForUser error = %v", err)
	}
	if result.Valid {
		t.Fatalf("result = %+v, want invalid: cleansed id without alias stays standalone", result)
	}
}

func TestValidateModelForUserAliasNoneStaysStandalone(t *testing.T) {
	service := customValidationService(t)
	result, err := service.ValidateModelForUser(context.Background(), "u1", "my-vllm/claude-sonnet-4-6", ModelAccess{Mode: "whitelist", Models: []string{"claude-sonnet-4-6"}})
	if err != nil {
		t.Fatalf("ValidateModelForUser error = %v", err)
	}
	if result.Valid {
		t.Fatalf("result = %+v, want invalid: alias none is standalone", result)
	}
}

func TestIsModelUsableByAccountsIncludesCustomProviderModels(t *testing.T) {
	service := customValidationService(t)
	canonical := service.registry.ResolveAlias("qwen3-32b")
	if !service.registry.IsSupported(canonical) {
		t.Fatalf("fixture alias %q does not resolve to a supported model", canonical)
	}
	availability := AccountModelAvailability{
		AccountCountByProvider: map[string]int{"my-vllm": 1},
		CustomProviderModels: map[string]map[string]struct{}{
			"my-vllm": {canonical: {}},
		},
	}
	if !service.IsModelUsableByAccounts(canonical, availability) {
		t.Fatalf("IsModelUsableByAccounts(%q) = false, want true via custom provider", canonical)
	}
	if service.IsModelUsableByAccounts(canonical, AccountModelAvailability{CustomProviderModels: map[string]map[string]struct{}{"my-vllm": {canonical: {}}}}) {
		t.Fatalf("IsModelUsableByAccounts(%q) = true without an account", canonical)
	}
}

var _ providers.CustomProviderReader = (*fakeCustomProviderReader)(nil)
