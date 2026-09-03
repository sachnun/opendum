package providers

import (
	"context"
	"database/sql"

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
	rows := []appdb.CustomProvider{}
	err := s.db.NewSelect().Model(&rows).
		Where("\"userId\" = ?", userID).
		Where("enabled = TRUE").
		OrderExpr("\"createdAt\" ASC").
		Scan(ctx)
	return rows, err
}

func (s *CustomStore) GetProvider(ctx context.Context, userID, slug string) (*appdb.CustomProvider, error) {
	if s == nil || s.db == nil {
		return nil, nil
	}
	row := &appdb.CustomProvider{}
	err := s.db.NewSelect().Model(row).
		Where("\"userId\" = ?", userID).
		Where("slug = ?", slug).
		Where("enabled = TRUE").
		Scan(ctx)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return row, nil
}

func (s *CustomStore) ListModels(ctx context.Context, providerID string) ([]appdb.CustomProviderModel, error) {
	if s == nil || s.db == nil {
		return nil, nil
	}
	rows := []appdb.CustomProviderModel{}
	err := s.db.NewSelect().Model(&rows).
		Where("\"providerId\" = ?", providerID).
		OrderExpr("\"modelId\" ASC").
		Scan(ctx)
	return rows, err
}
