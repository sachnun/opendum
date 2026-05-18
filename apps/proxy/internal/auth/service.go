package auth

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/opendum/opendum/apps/proxy/internal/cryptojs"
	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
	"github.com/opendum/opendum/apps/proxy/internal/models"
)

const (
	validationPrefix         = "opendum:api-key:validation"
	lastUsedPrefix           = "opendum:api-key:last-used"
	disabledModelsPrefix     = "opendum:user:disabled-models"
	validTTL                 = 45 * time.Second
	invalidTTL               = 10 * time.Second
	lastUsedTTL              = 60 * time.Second
	disabledModelsTTL        = 60 * time.Second
	analyticsVersionPrefix   = "opendum:analytics:v1:version"
	analyticsVersionBumpPref = "opendum:analytics:v1:version-bump"
	analyticsVersionTTL      = 30 * 24 * time.Hour
	analyticsBumpTTL         = 15 * time.Second
)

type Service struct {
	db       *appdb.DB
	redis    *redis.Client
	registry *models.Registry
}

func NewService(db *appdb.DB, redisClient *redis.Client, registry *models.Registry) *Service {
	return &Service{db: db, redis: redisClient, registry: registry}
}

func (s *Service) ValidateAPIKey(ctx context.Context, authHeader string) (Result, error) {
	if strings.TrimSpace(authHeader) == "" {
		return Result{Valid: false, Error: "Missing Authorization header"}, nil
	}

	token := bearerToken(authHeader)
	if token == "" {
		return Result{Valid: false, Error: "Invalid Authorization header format"}, nil
	}

	keyHash := cryptojs.HashString(token)
	if cached, ok := s.getCachedAPIKeyValidation(ctx, keyHash); ok {
		if !cached.Valid {
			if cached.APIKeyID == "" || s.isCachedAPIKeyValidationCurrent(ctx, cached) {
				return Result{Valid: false, Error: defaultString(cached.Error, "Invalid API key")}, nil
			}
			_ = s.InvalidateAPIKeyValidation(ctx, keyHash, cached.APIKeyID)
		} else if cached.ExpiresAtMs == nil || *cached.ExpiresAtMs > time.Now().UnixMilli() {
			if s.isCachedAPIKeyValidationCurrent(ctx, cached) {
				go s.touchAPIKeyLastUsed(context.Background(), cached.APIKeyID)
				return s.resultFromCache(cached), nil
			}
			_ = s.InvalidateAPIKeyValidation(ctx, keyHash, cached.APIKeyID)
		} else {
			_ = s.InvalidateAPIKeyValidation(ctx, keyHash, cached.APIKeyID)
		}
	}

	var apiKey appdb.ProxyAPIKey
	err := s.db.NewSelect().Model(&apiKey).
		Column("id", "userId", "isActive", "expiresAt", "updatedAt", "modelAccessMode", "modelAccessList", "accountAccessMode", "accountAccessList", "roamingEnabled").
		Where("\"keyHash\" = ?", keyHash).
		Limit(1).
		Scan(ctx)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			_ = s.setCachedAPIKeyValidation(ctx, keyHash, cacheValue{Valid: false, Error: "Invalid API key"}, invalidTTL)
			return Result{Valid: false, Error: "Invalid API key"}, nil
		}
		return Result{}, err
	}
	updatedAtMicros := apiKey.UpdatedAt.UnixMicro()

	if !apiKey.IsActive {
		_ = s.setCachedAPIKeyValidation(ctx, keyHash, cacheValue{Valid: false, APIKeyID: apiKey.ID, UpdatedAtMicros: &updatedAtMicros, Error: "API key has been revoked"}, invalidTTL)
		return Result{Valid: false, Error: "API key has been revoked"}, nil
	}

	if apiKey.ExpiresAt != nil && apiKey.ExpiresAt.Before(time.Now()) {
		go func() {
			_, _ = s.db.NewUpdate().Model((*appdb.ProxyAPIKey)(nil)).Set("\"isActive\" = FALSE").Where("id = ?", apiKey.ID).Exec(context.Background())
		}()
		_ = s.setCachedAPIKeyValidation(ctx, keyHash, cacheValue{Valid: false, APIKeyID: apiKey.ID, UpdatedAtMicros: &updatedAtMicros, Error: "API key has expired"}, invalidTTL)
		return Result{Valid: false, Error: "API key has expired"}, nil
	}

	rules, err := s.getRateLimitRules(ctx, apiKey.ID)
	if err != nil {
		return Result{}, err
	}

	modelMode := normalizeAccessMode(apiKey.ModelAccessMode)
	modelList := s.normalizeModelList(apiKey.ModelAccessList)
	accountMode := normalizeAccessMode(apiKey.AccountAccessMode)
	accountList := normalizeAccountList(apiKey.AccountAccessList)

	var expiresAtMs *int64
	cacheTTL := validTTL
	if apiKey.ExpiresAt != nil {
		ms := apiKey.ExpiresAt.UnixMilli()
		expiresAtMs = &ms
		untilExpiry := time.Until(*apiKey.ExpiresAt)
		if untilExpiry > 0 && untilExpiry < cacheTTL {
			cacheTTL = untilExpiry
		}
		if cacheTTL < time.Second {
			cacheTTL = time.Second
		}
	}

	cached := cacheValue{
		Valid:             true,
		UserID:            apiKey.UserID,
		APIKeyID:          apiKey.ID,
		ModelAccessMode:   modelMode,
		ModelAccessList:   modelList,
		AccountAccessMode: accountMode,
		AccountAccessList: accountList,
		RoamingEnabled:    apiKey.RoamingEnabled,
		ExpiresAtMs:       expiresAtMs,
		UpdatedAtMicros:   &updatedAtMicros,
		RateLimitRules:    rules,
	}
	_ = s.setCachedAPIKeyValidation(ctx, keyHash, cached, cacheTTL)
	go s.touchAPIKeyLastUsed(context.Background(), apiKey.ID)

	return s.resultFromCache(cached), nil
}

func (s *Service) isCachedAPIKeyValidationCurrent(ctx context.Context, cached cacheValue) bool {
	if cached.APIKeyID == "" || cached.UpdatedAtMicros == nil {
		return false
	}

	var apiKey appdb.ProxyAPIKey
	err := s.db.NewSelect().Model(&apiKey).
		Column("id", "isActive", "expiresAt", "updatedAt").
		Where("id = ?", cached.APIKeyID).
		Limit(1).
		Scan(ctx)
	if err != nil {
		return !errors.Is(err, sql.ErrNoRows)
	}
	if apiKey.UpdatedAt.UnixMicro() != *cached.UpdatedAtMicros {
		return false
	}
	if cached.Valid && (!apiKey.IsActive || (apiKey.ExpiresAt != nil && !apiKey.ExpiresAt.After(time.Now()))) {
		return false
	}
	if !cached.Valid && apiKey.IsActive && (apiKey.ExpiresAt == nil || apiKey.ExpiresAt.After(time.Now())) {
		return false
	}
	return true
}

func (s *Service) getRateLimitRules(ctx context.Context, apiKeyID string) ([]RateLimitRule, error) {
	var rows []appdb.ProxyAPIKeyRateLimit
	err := s.db.NewSelect().Model(&rows).
		Column("target", "targetType", "perMinute", "perHour", "perDay").
		Where("\"apiKeyId\" = ?", apiKeyID).
		Scan(ctx)
	if err != nil {
		return nil, err
	}

	rules := make([]RateLimitRule, 0, len(rows))
	for _, row := range rows {
		targetType := row.TargetType
		if targetType != "family" {
			targetType = "model"
		}
		rules = append(rules, RateLimitRule{Target: row.Target, TargetType: targetType, PerMinute: row.PerMinute, PerHour: row.PerHour, PerDay: row.PerDay})
	}
	return rules, nil
}

func (s *Service) resultFromCache(cached cacheValue) Result {
	return Result{
		Valid:             true,
		UserID:            cached.UserID,
		APIKeyID:          cached.APIKeyID,
		ModelAccessMode:   normalizeAccessMode(cached.ModelAccessMode),
		ModelAccessList:   s.normalizeModelList(cached.ModelAccessList),
		AccountAccessMode: normalizeAccessMode(cached.AccountAccessMode),
		AccountAccessList: normalizeAccountList(cached.AccountAccessList),
		RoamingEnabled:    cached.RoamingEnabled,
		RateLimitRules:    cached.RateLimitRules,
	}
}

func bearerToken(authHeader string) string {
	trimmed := strings.TrimSpace(authHeader)
	if len(trimmed) >= 7 && strings.EqualFold(trimmed[:7], "Bearer ") {
		return strings.TrimSpace(trimmed[7:])
	}
	return trimmed
}
