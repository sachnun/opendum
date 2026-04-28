package auth

import (
	"context"
	"encoding/json"
	"time"
)

func validationKey(keyHash string) string { return validationPrefix + ":" + keyHash }

func lastUsedKey(apiKeyID string) string { return lastUsedPrefix + ":" + apiKeyID }

func disabledModelsKey(userID string) string { return disabledModelsPrefix + ":" + userID }

func analyticsVersionKey(userID string) string { return analyticsVersionPrefix + ":" + userID }

func analyticsVersionBumpKey(userID string) string { return analyticsVersionBumpPref + ":" + userID }

func (s *Service) getCachedAPIKeyValidation(ctx context.Context, keyHash string) (cacheValue, bool) {
	raw, err := s.redis.Get(ctx, validationKey(keyHash)).Result()
	if err != nil || raw == "" {
		return cacheValue{}, false
	}
	var value cacheValue
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		return cacheValue{}, false
	}
	return value, true
}

func (s *Service) setCachedAPIKeyValidation(ctx context.Context, keyHash string, value cacheValue, ttl time.Duration) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return s.redis.Set(ctx, validationKey(keyHash), data, ttl).Err()
}

func (s *Service) InvalidateAPIKeyValidation(ctx context.Context, keyHash, apiKeyID string) error {
	keys := []string{validationKey(keyHash)}
	if apiKeyID != "" {
		keys = append(keys, lastUsedKey(apiKeyID))
	}
	return s.redis.Del(ctx, keys...).Err()
}

func (s *Service) touchAPIKeyLastUsed(ctx context.Context, apiKeyID string) {
	if apiKeyID == "" {
		return
	}
	updated, err := s.redis.SetNX(ctx, lastUsedKey(apiKeyID), "1", lastUsedTTL).Result()
	if err == nil && !updated {
		return
	}
	_, _ = s.db.NewUpdate().TableExpr("proxy_api_key").Set("\"lastUsedAt\" = NOW()").Where("id = ?", apiKeyID).Exec(ctx)
}

func (s *Service) getCachedDisabledModels(ctx context.Context, userID string) ([]string, bool) {
	raw, err := s.redis.Get(ctx, disabledModelsKey(userID)).Result()
	if err != nil || raw == "" {
		return nil, false
	}
	var value disabledModelsCacheValue
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		return nil, false
	}
	return s.normalizeModelList(value.Models), true
}

func (s *Service) setCachedDisabledModels(ctx context.Context, userID string, modelList []string) error {
	data, err := json.Marshal(disabledModelsCacheValue{Models: s.normalizeModelList(modelList)})
	if err != nil {
		return err
	}
	return s.redis.Set(ctx, disabledModelsKey(userID), data, disabledModelsTTL).Err()
}

func (s *Service) BumpAnalyticsCacheVersionThrottled(ctx context.Context, userID string) {
	if userID == "" {
		return
	}
	updated, err := s.redis.SetNX(ctx, analyticsVersionBumpKey(userID), "1", analyticsBumpTTL).Result()
	if err != nil || !updated {
		return
	}
	version, err := s.redis.Incr(ctx, analyticsVersionKey(userID)).Result()
	if err == nil && version == 1 {
		_ = s.redis.Expire(ctx, analyticsVersionKey(userID), analyticsVersionTTL).Err()
	}
}
