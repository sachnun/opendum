package proxy

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
)

type usageParams struct {
	UserID            string
	ProviderAccountID string
	ProxyAPIKeyID     string
	Model             string
	InputTokens       int
	OutputTokens      int
	StatusCode        int
	DurationMS        int
	Provider          string
}

func (s *Service) logUsage(ctx context.Context, params usageParams) {
	if params.UserID == "" || params.Model == "" {
		return
	}
	now := time.Now()
	var providerAccountID *string
	if params.ProviderAccountID != "" && !isSyntheticProviderAccountID(params.ProviderAccountID) {
		providerAccountID = &params.ProviderAccountID
	}
	var proxyAPIKeyID *string
	if params.ProxyAPIKeyID != "" {
		proxyAPIKeyID = &params.ProxyAPIKeyID
	}
	status := params.StatusCode
	duration := params.DurationMS
	row := appdb.UsageLog{
		ID:                appdb.NewID(),
		UserID:            params.UserID,
		ProviderAccountID: providerAccountID,
		ProxyAPIKeyID:     proxyAPIKeyID,
		Model:             params.Model,
		InputTokens:       params.InputTokens,
		OutputTokens:      params.OutputTokens,
		StatusCode:        &status,
		Duration:          &duration,
		CreatedAt:         now,
	}
	if _, err := s.db.NewInsert().Model(&row).Exec(ctx); err == nil {
		go s.auth.BumpAnalyticsCacheVersionThrottled(context.Background(), params.UserID)
	}
}

func (s *Service) recordLatency(ctx context.Context, provider, model string, stream bool, latencyMS int64) {
	if latencyMS <= 0 {
		return
	}
	mode := "nonstream"
	if stream {
		mode = "stream"
	}
	key := fmt.Sprintf("opendum:latency:%s:%s:%s", provider, strings.ToLower(strings.TrimSpace(model)), mode)
	now := time.Now().UnixMilli()
	member := strconv.FormatInt(latencyMS, 10) + ":" + strconv.FormatInt(now, 10)
	pipe := s.redis.Pipeline()
	pipe.ZAdd(ctx, key, redis.Z{Score: float64(now), Member: member})
	pipe.ZRemRangeByRank(ctx, key, 0, -101)
	pipe.Expire(ctx, key, 24*time.Hour)
	_, _ = pipe.Exec(ctx)
}
