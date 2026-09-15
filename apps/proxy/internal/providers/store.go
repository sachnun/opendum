package providers

import (
	"context"

	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
)

type CustomStore struct {
	db *appdb.DB
}

type CustomProviderReader interface {
	ListProviders(ctx context.Context, userID string) ([]appdb.CustomProvider, error)
	GetProvider(ctx context.Context, userID, slug string) (*appdb.CustomProvider, error)
	ListModels(ctx context.Context, providerID string) ([]appdb.CustomProviderModel, error)
}

func NewCustomStore(db *appdb.DB) *CustomStore {
	return &CustomStore{db: db}
}

func (s *CustomStore) ListProviders(ctx context.Context, userID string) ([]appdb.CustomProvider, error) {
	if s == nil || s.db == nil {
		return nil, nil
	}
	return s.db.ListCustomProviders(ctx, userID)
}

func (s *CustomStore) GetProvider(ctx context.Context, userID, slug string) (*appdb.CustomProvider, error) {
	if s == nil || s.db == nil {
		return nil, nil
	}
	return s.db.GetCustomProvider(ctx, userID, slug)
}

func (s *CustomStore) ListModels(ctx context.Context, providerID string) ([]appdb.CustomProviderModel, error) {
	if s == nil || s.db == nil {
		return nil, nil
	}
	return s.db.ListCustomProviderModels(ctx, providerID)
}
