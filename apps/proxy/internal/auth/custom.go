package auth

import (
	"context"
	"time"
)

func (s *Service) ListUserCustomModels(ctx context.Context, userID string) ([]map[string]any, error) {
	if s.customProviders == nil {
		return nil, nil
	}
	providers, err := s.customProviders.ListProviders(ctx, userID)
	if err != nil {
		return nil, err
	}
	now := time.Now().Unix()
	items := []map[string]any{}
	for _, custom := range providers {
		models, err := s.customProviders.ListModels(ctx, custom.ID)
		if err != nil {
			return nil, err
		}
		for _, row := range models {
			items = append(items, map[string]any{
				"id":       custom.Slug + "/" + row.ModelID,
				"object":   "model",
				"created":  now,
				"owned_by": "custom:" + custom.Slug,
			})
		}
	}
	return items, nil
}
