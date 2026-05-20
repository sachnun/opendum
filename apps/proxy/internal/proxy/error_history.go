package proxy

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
)

const (
	errorHistoryKeyPrefix       = "opendum:provider-account:error-history"
	errorHistoryEntryKeyPrefix  = "opendum:provider-account:error-history-entry"
	errorHistoryDedupeKeyPrefix = "opendum:provider-account:error-history-dedupe"
	errorHistoryDefaultTTL      = 14 * 24 * time.Hour
	errorHistoryRateLimitTTL    = 3 * 24 * time.Hour
)

type redisErrorHistoryEntry struct {
	ID                string  `json:"id"`
	ProviderAccountID string  `json:"providerAccountId"`
	UserID            string  `json:"userId"`
	Model             *string `json:"model"`
	ErrorCode         int     `json:"errorCode"`
	ErrorMessage      string  `json:"errorMessage"`
	CreatedAt         string  `json:"createdAt"`
	DedupeKey         string  `json:"dedupeKey"`
}

func errorHistoryTTL(statusCode int) time.Duration {
	if statusCode == http.StatusTooManyRequests {
		return errorHistoryRateLimitTTL
	}
	return errorHistoryDefaultTTL
}

func errorHistoryKey(accountID string) string {
	return fmt.Sprintf("%s:%s", errorHistoryKeyPrefix, accountID)
}

func errorHistoryEntryKey(entryID string) string {
	return fmt.Sprintf("%s:%s", errorHistoryEntryKeyPrefix, entryID)
}

func errorHistoryDedupeKey(accountID string, model *string, statusCode int, message string) string {
	modelValue := ""
	if model != nil {
		modelValue = *model
	}
	hash := sha256.Sum256([]byte(strings.Join([]string{accountID, modelValue, fmt.Sprint(statusCode), message}, "\x00")))
	return fmt.Sprintf("%s:%s:%s", errorHistoryDedupeKeyPrefix, accountID, hex.EncodeToString(hash[:]))
}

func (s *Service) upsertErrorHistory(ctx context.Context, accountID, userID string, model *string, statusCode int, message string, createdAt time.Time) error {
	if s.redis == nil {
		return nil
	}

	dedupeKey := errorHistoryDedupeKey(accountID, model, statusCode, message)
	entryID, err := s.redis.Get(ctx, dedupeKey).Result()
	if err != nil && err != redis.Nil {
		return err
	}
	if entryID == "" || err == redis.Nil {
		entryID = appdb.NewID()
	}

	entry := redisErrorHistoryEntry{
		ID:                entryID,
		ProviderAccountID: accountID,
		UserID:            userID,
		Model:             model,
		ErrorCode:         statusCode,
		ErrorMessage:      message,
		CreatedAt:         createdAt.UTC().Format(time.RFC3339Nano),
		DedupeKey:         dedupeKey,
	}
	encoded, err := json.Marshal(entry)
	if err != nil {
		return err
	}

	ttl := errorHistoryTTL(statusCode)
	pipe := s.redis.Pipeline()
	pipe.Set(ctx, errorHistoryEntryKey(entryID), encoded, ttl)
	pipe.Set(ctx, dedupeKey, entryID, ttl)
	pipe.ZAdd(ctx, errorHistoryKey(accountID), redis.Z{Score: float64(createdAt.UnixMilli()), Member: entryID})
	pipe.Expire(ctx, errorHistoryKey(accountID), errorHistoryDefaultTTL)
	_, err = pipe.Exec(ctx)
	return err
}
