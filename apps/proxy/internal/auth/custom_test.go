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
	registry, err := models.Load(filepath.Join("..", "..", "..", "..", "models"))
	if err != nil {
		t.Fatalf("load registry: %v", err)
	}
	provider := db.CustomProvider{ID: "prov_1", UserID: "u1", Slug: "my-vllm", BaseURL: "https://vllm.internal/v1", Enabled: true}
	rows := []db.CustomProviderModel{
		{ID: "m_1", ProviderID: "prov_1", ModelID: "qwen3-32b", Upstream: "Qwen/Qwen3-32B", Meta: map[string]any{"vision": true, "toolCall": false}},
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
	if result.Vision == nil || !*result.Vision {
		t.Fatalf("Vision = %v, want true", result.Vision)
	}
	if result.ToolCall == nil || *result.ToolCall {
		t.Fatalf("ToolCall = %v, want false", result.ToolCall)
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
	registry, err := models.Load(filepath.Join("..", "..", "..", "..", "models"))
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

var _ providers.CustomProviderReader = (*fakeCustomProviderReader)(nil)
