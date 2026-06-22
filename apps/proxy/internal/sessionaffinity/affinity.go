package sessionaffinity

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	defaultTTL = 30 * time.Minute
	keyPrefix  = "opendum:session-affinity"
)

type Option func(*Affinity)

func WithTTL(d time.Duration) Option {
	return func(a *Affinity) {
		if d > 0 {
			a.ttl = d
		}
	}
}

type Affinity struct {
	redis     *redis.Client
	ttl       time.Duration
	providers map[string]struct{}
}

func New(client *redis.Client, providers []string, opts ...Option) *Affinity {
	a := &Affinity{
		redis:     client,
		ttl:       defaultTTL,
		providers: make(map[string]struct{}, len(providers)),
	}
	for _, p := range providers {
		if p = strings.TrimSpace(p); p != "" {
			a.providers[p] = struct{}{}
		}
	}
	for _, opt := range opts {
		if opt != nil {
			opt(a)
		}
	}
	return a
}

func (a *Affinity) Enabled(provider string) bool {
	if a == nil {
		return false
	}
	_, ok := a.providers[strings.TrimSpace(provider)]
	return ok
}

func (a *Affinity) Lookup(ctx context.Context, userID, sessionID string) string {
	if a == nil || a.redis == nil || !validPair(userID, sessionID) {
		return ""
	}
	id, err := a.redis.Get(ctx, affinityKey(userID, sessionID)).Result()
	if err != nil {
		return ""
	}
	return id
}

func (a *Affinity) Store(ctx context.Context, userID, sessionID, accountID string) {
	if a == nil || a.redis == nil || !validPair(userID, sessionID) || strings.TrimSpace(accountID) == "" {
		return
	}
	_ = a.redis.Set(ctx, affinityKey(userID, sessionID), accountID, a.ttl).Err()
}

func (a *Affinity) Forget(ctx context.Context, userID, sessionID string) {
	if a == nil || a.redis == nil || !validPair(userID, sessionID) {
		return
	}
	_ = a.redis.Del(ctx, affinityKey(userID, sessionID)).Err()
}

func Prefer[T any](items []T, isSticky func(T) bool) []T {
	if len(items) == 0 || isSticky == nil {
		return items
	}
	for i := range items {
		if isSticky(items[i]) {
			if i == 0 {
				return items
			}
			moved := make([]T, 0, len(items))
			moved = append(moved, items[i])
			moved = append(moved, items[:i]...)
			moved = append(moved, items[i+1:]...)
			return moved
		}
	}
	return items
}

func affinityKey(userID, sessionID string) string {
	return fmt.Sprintf("%s:%s:%s", keyPrefix, userID, sessionID)
}

func validPair(userID, sessionID string) bool {
	return strings.TrimSpace(userID) != "" && strings.TrimSpace(sessionID) != ""
}
