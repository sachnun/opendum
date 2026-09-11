package providers

import (
	"context"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	fallbackStickyPrefix = "opendum:provider:fallback"
	fallbackStrikePrefix = "opendum:provider:fallback-strikes"
	fallbackStickyTTL    = 10 * time.Minute
	fallbackStrikeWindow = 5 * time.Minute
	fallbackStrikeLimit  = 2
)

type fallbackState interface {
	sticky(ctx context.Context, provider string) bool
	recordStrike(ctx context.Context, provider string)
	clear(ctx context.Context, provider string)
}

type fallbackRouter struct {
	redis *redis.Client
}

func newFallbackRouter(redis *redis.Client) *fallbackRouter {
	return &fallbackRouter{redis: redis}
}

func (f *fallbackRouter) sticky(ctx context.Context, provider string) bool {
	if f == nil || f.redis == nil || provider == "" {
		return false
	}
	exists, err := f.redis.Exists(ctx, fallbackStickyKey(provider)).Result()
	return err == nil && exists > 0
}

func (f *fallbackRouter) recordStrike(ctx context.Context, provider string) {
	if f == nil || f.redis == nil || provider == "" {
		return
	}
	strikeKey := fallbackStrikeKey(provider)
	count, err := f.redis.Incr(ctx, strikeKey).Result()
	if err != nil {
		return
	}
	if count == 1 {
		_ = f.redis.Expire(ctx, strikeKey, fallbackStrikeWindow).Err()
	}
	if count < fallbackStrikeLimit {
		return
	}
	_ = f.redis.Set(ctx, fallbackStickyKey(provider), "1", fallbackStickyTTL).Err()
	_ = f.redis.Del(ctx, strikeKey).Err()
}

func (f *fallbackRouter) clear(ctx context.Context, provider string) {
	if f == nil || f.redis == nil || provider == "" {
		return
	}
	_ = f.redis.Del(ctx, fallbackStickyKey(provider), fallbackStrikeKey(provider)).Err()
}

func fallbackStickyKey(provider string) string {
	return fallbackStickyPrefix + ":" + provider
}

func fallbackStrikeKey(provider string) string {
	return fallbackStrikePrefix + ":" + provider
}

type noFallbackState struct{}

func (noFallbackState) sticky(context.Context, string) bool  { return false }
func (noFallbackState) recordStrike(context.Context, string) {}
func (noFallbackState) clear(context.Context, string)        {}

type endpointPoster func(url string) (*http.Response, error)

func postWithFallback(ctx context.Context, state fallbackState, provider, primary, fallback string, post endpointPoster) (*http.Response, error) {
	if state == nil {
		state = noFallbackState{}
	}
	if fallback == "" {
		return post(primary)
	}
	if state.sticky(ctx, provider) {
		resp, err := post(fallback)
		if err != nil || resp == nil || !shouldUseFallbackEndpoint(resp.StatusCode) {
			return resp, err
		}
		_ = resp.Body.Close()
		return postPrimary(ctx, state, provider, primary, post)
	}
	resp, err := postPrimary(ctx, state, provider, primary, post)
	if err != nil || resp == nil || !shouldUseFallbackEndpoint(resp.StatusCode) {
		return resp, err
	}
	_ = resp.Body.Close()
	state.recordStrike(ctx, provider)
	return post(fallback)
}

func postPrimary(ctx context.Context, state fallbackState, provider, primary string, post endpointPoster) (*http.Response, error) {
	resp, err := post(primary)
	if err == nil && resp != nil && resp.StatusCode >= 200 && resp.StatusCode < 300 {
		state.clear(ctx, provider)
	}
	return resp, err
}
