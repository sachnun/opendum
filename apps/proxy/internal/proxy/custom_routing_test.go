package proxy

import (
	"context"
	"testing"

	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
	"github.com/opendum/opendum/apps/proxy/internal/providers"
)

type fakeCustomStore struct {
	providers []appdb.CustomProvider
	models    map[string][]appdb.CustomProviderModel
}

func (f *fakeCustomStore) ListProviders(ctx context.Context, userID string) ([]appdb.CustomProvider, error) {
	return f.providers, nil
}

func (f *fakeCustomStore) GetProvider(ctx context.Context, userID, slug string) (*appdb.CustomProvider, error) {
	for i := range f.providers {
		if f.providers[i].Slug == slug {
			return &f.providers[i], nil
		}
	}
	return nil, nil
}

func (f *fakeCustomStore) ListModels(ctx context.Context, providerID string) ([]appdb.CustomProviderModel, error) {
	return f.models[providerID], nil
}

var _ providers.CustomProviderReader = (*fakeCustomStore)(nil)

func TestCustomProviderSlugsForModelMatchesAliases(t *testing.T) {
	t.Parallel()
	aliasedUpstream := "Qwen/Qwen3-32B"
	selfUpstream := mockFamilyModel
	service := &Service{
		registry: mockRegistry(t),
		customStore: &fakeCustomStore{
			providers: []appdb.CustomProvider{
				{ID: "p1", Slug: "my-vllm"},
				{ID: "p2", Slug: "self-vllm"},
			},
			models: map[string][]appdb.CustomProviderModel{
				"p1": {
					{ID: "m1", ProviderID: "p1", ModelID: mockFamilyModel, Upstream: &aliasedUpstream, Aliased: true},
					{ID: "m2", ProviderID: "p1", ModelID: "local-thing", Upstream: &aliasedUpstream},
				},
				"p2": {
					{ID: "m3", ProviderID: "p2", ModelID: mockFamilyModel, Upstream: &selfUpstream},
				},
			},
		},
	}

	slugs := service.customProviderSlugsForModel(context.Background(), "u1", mockFamilyModel)
	if len(slugs) != 1 || slugs[0] != "my-vllm" {
		t.Fatalf("slugs = %v, want [my-vllm]", slugs)
	}
}
