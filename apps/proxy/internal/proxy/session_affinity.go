package proxy

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"time"

	"github.com/redis/go-redis/v9"

	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
)

const (
	sessionAffinityPrefix = "opendum:session-affinity:"
	sessionAffinityTTL    = 5 * time.Minute
)

// sessionAffinityKey returns the Redis key for a user+session pair.
// The session ID is hashed so arbitrary-length client values stay short.
func sessionAffinityKey(userID, sessionID string) string {
	sum := sha256.Sum256([]byte(sessionID))
	return sessionAffinityPrefix + userID + ":" + hex.EncodeToString(sum[:])
}

// getAffinityAccountID looks up the cached account for a session.
// Returns "" on miss or if Redis is unavailable.
func getAffinityAccountID(ctx context.Context, r *redis.Client, userID, sessionID string) string {
	if r == nil || sessionID == "" {
		return ""
	}
	val, err := r.Get(ctx, sessionAffinityKey(userID, sessionID)).Result()
	if err != nil {
		return ""
	}
	return val
}

// setAffinityAccountID stores (or refreshes) the session→account mapping.
func setAffinityAccountID(ctx context.Context, r *redis.Client, userID, sessionID, accountID string) {
	if r == nil || sessionID == "" || accountID == "" {
		return
	}
	_ = r.Set(ctx, sessionAffinityKey(userID, sessionID), accountID, sessionAffinityTTL).Err()
}

// deleteAffinityAccountID removes the mapping (e.g. when the account fails).
func deleteAffinityAccountID(ctx context.Context, r *redis.Client, userID, sessionID string) {
	if r == nil || sessionID == "" {
		return
	}
	_ = r.Del(ctx, sessionAffinityKey(userID, sessionID)).Err()
}

// boostAffinityAccount re-orders accounts so that affinityAccountID appears
// first while preserving the relative order of all other accounts. If the
// target is not found in the list (e.g. account became unhealthy/excluded),
// the slice is returned unchanged.
func boostAffinityAccount(accounts []appdb.ProviderAccount, affinityAccountID string) []appdb.ProviderAccount {
	if len(accounts) <= 1 || affinityAccountID == "" {
		return accounts
	}
	idx := -1
	for i, a := range accounts {
		if a.ID == affinityAccountID {
			idx = i
			break
		}
	}
	if idx <= 0 { // not found (-1) or already first (0)
		return accounts
	}
	target := accounts[idx]
	copy(accounts[1:idx+1], accounts[:idx])
	accounts[0] = target
	return accounts
}
