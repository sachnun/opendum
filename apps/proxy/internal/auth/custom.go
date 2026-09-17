package auth

import (
	"context"
	"time"
)

func (s *Service) customProviderModelSets(ctx context.Context, userID string) (map[string]map[string]struct{}, map[string][]string, error) {
	aliased := map[string]map[string]struct{}{}
	standalone := map[string][]string{}
	if s.customProviders == nil {
		return aliased, standalone, nil
	}
	providers, err := s.customProviders.ListProviders(ctx, userID)
	if err != nil {
		return nil, nil, err
	}
	for _, custom := range providers {
		rows, err := s.customProviders.ListModels(ctx, custom.ID)
		if err != nil {
			return nil, nil, err
		}
		for _, row := range rows {
			canonical := s.registry.ResolveAlias(row.ModelID)
			if row.Aliased && s.registry.IsSupported(canonical) {
				if aliased[custom.Slug] == nil {
					aliased[custom.Slug] = map[string]struct{}{}
				}
				aliased[custom.Slug][canonical] = struct{}{}
				continue
			}
			standalone[custom.Slug] = append(standalone[custom.Slug], row.ModelID)
		}
	}
	return aliased, standalone, nil
}

func (s *Service) ListUserCustomModels(ctx context.Context, userID string) ([]map[string]any, error) {
	_, standalone, err := s.customProviderModelSets(ctx, userID)
	if err != nil {
		return nil, err
	}
	now := time.Now().Unix()
	items := []map[string]any{}
	for slug, models := range standalone {
		for _, modelID := range models {
			items = append(items, map[string]any{
				"id":       slug + "/" + modelID,
				"object":   "model",
				"created":  now,
				"owned_by": "custom:" + slug,
			})
		}
	}
	return items, nil
}
