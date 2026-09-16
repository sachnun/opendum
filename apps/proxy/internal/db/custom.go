package db

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5"
)

func (d *DB) ListCustomProviders(ctx context.Context, userID string) ([]CustomProvider, error) {
	if d == nil || d.Pool == nil {
		return nil, nil
	}
	rows, err := d.Pool.Query(ctx, `
		SELECT id, "userId", slug, name, "baseUrl", "extraHeaders", enabled, "createdAt", "updatedAt"
		FROM custom_provider
		WHERE "userId" = $1 AND enabled = TRUE
		ORDER BY "createdAt" ASC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanCustomProviders(rows)
}

func (d *DB) GetCustomProvider(ctx context.Context, userID, slug string) (*CustomProvider, error) {
	if d == nil || d.Pool == nil {
		return nil, nil
	}
	rows, err := d.Pool.Query(ctx, `
		SELECT id, "userId", slug, name, "baseUrl", "extraHeaders", enabled, "createdAt", "updatedAt"
		FROM custom_provider
		WHERE "userId" = $1 AND slug = $2 AND enabled = TRUE
		LIMIT 1`, userID, slug)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	providers, err := scanCustomProviders(rows)
	if err != nil {
		return nil, err
	}
	if len(providers) == 0 {
		return nil, nil
	}
	return &providers[0], nil
}

func (d *DB) ListCustomProviderModels(ctx context.Context, providerID string) ([]CustomProviderModel, error) {
	if d == nil || d.Pool == nil {
		return nil, nil
	}
	rows, err := d.Pool.Query(ctx, `
		SELECT id, "providerId", "modelId", upstream, authless, "minTier", "allowedTiers", "customFlags", "createdAt", "updatedAt"
		FROM custom_provider_model
		WHERE "providerId" = $1
		ORDER BY "modelId" ASC`, providerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanCustomProviderModels(rows)
}

func (d *DB) ListSharedCustomProviderModels(ctx context.Context, excludeUserID, slug string) ([]CustomProviderModel, error) {
	if d == nil || d.Pool == nil {
		return nil, nil
	}
	rows, err := d.Pool.Query(ctx, `
		SELECT custom_provider_model.id, custom_provider_model."providerId", custom_provider_model."modelId", custom_provider_model.upstream, custom_provider_model.authless, custom_provider_model."minTier", custom_provider_model."allowedTiers", custom_provider_model."customFlags", custom_provider_model."createdAt", custom_provider_model."updatedAt"
		FROM custom_provider_model
		JOIN custom_provider ON custom_provider.id = custom_provider_model."providerId"
		JOIN user_sharing_setting ON user_sharing_setting."userId" = custom_provider."userId"
		WHERE custom_provider."userId" <> $1
		  AND user_sharing_setting.enabled
		  AND custom_provider.enabled
		  AND custom_provider.slug = $2
		ORDER BY custom_provider_model."modelId" ASC`, excludeUserID, slug)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanCustomProviderModels(rows)
}

func (d *DB) ListSharedCustomProviderSlugsByModel(ctx context.Context, excludeUserID, model string) ([]string, error) {
	if d == nil || d.Pool == nil {
		return nil, nil
	}
	rows, err := d.Pool.Query(ctx, `
		SELECT DISTINCT custom_provider.slug
		FROM custom_provider
		JOIN custom_provider_model ON custom_provider_model."providerId" = custom_provider.id
		JOIN user_sharing_setting ON user_sharing_setting."userId" = custom_provider."userId"
		WHERE custom_provider."userId" <> $1
		  AND user_sharing_setting.enabled
		  AND custom_provider.enabled
		  AND custom_provider_model."modelId" = $2
		ORDER BY custom_provider.slug ASC`, excludeUserID, model)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	slugs := []string{}
	for rows.Next() {
		var slug string
		if err := rows.Scan(&slug); err != nil {
			return nil, err
		}
		slugs = append(slugs, slug)
	}
	return slugs, rows.Err()
}

func scanCustomProviderModels(rows pgx.Rows) ([]CustomProviderModel, error) {
	models := []CustomProviderModel{}
	for rows.Next() {
		var row CustomProviderModel
		var upstream, minTier *string
		var flags []byte
		if err := rows.Scan(&row.ID, &row.ProviderID, &row.ModelID, &upstream, &row.Authless, &minTier, &row.AllowedTiers, &flags, &row.CreatedAt, &row.UpdatedAt); err != nil {
			return nil, err
		}
		row.Upstream = upstream
		row.MinTier = minTier
		if len(flags) > 0 {
			_ = json.Unmarshal(flags, &row.CustomFlags)
		}
		models = append(models, row)
	}
	return models, rows.Err()
}

func scanCustomProviders(rows pgx.Rows) ([]CustomProvider, error) {
	providers := []CustomProvider{}
	for rows.Next() {
		var row CustomProvider
		var raw []byte
		if err := rows.Scan(&row.ID, &row.UserID, &row.Slug, &row.Name, &row.BaseURL, &raw, &row.Enabled, &row.CreatedAt, &row.UpdatedAt); err != nil {
			return nil, err
		}
		if len(raw) > 0 {
			_ = json.Unmarshal(raw, &row.ExtraHeaders)
		}
		providers = append(providers, row)
	}
	return providers, rows.Err()
}
