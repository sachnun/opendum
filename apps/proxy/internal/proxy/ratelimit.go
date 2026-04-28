package proxy

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/opendum/opendum/apps/proxy/internal/auth"
)

const accountRateLimitPrefix = "opendum:rate-limit"
const apiKeyRateLimitPrefix = "opendum:api-key-rl"

type accountRateLimitEntry struct {
	ResetTime int64  `json:"resetTime"`
	Model     string `json:"model,omitempty"`
	Message   string `json:"message,omitempty"`
}

func rateLimitScope(model string) string {
	return strings.ToLower(strings.TrimSpace(model))
}

func accountRateLimitKey(accountID, scope string) string {
	return accountRateLimitPrefix + ":" + accountID + ":" + scope
}

func (s *Service) markRateLimited(ctx context.Context, accountID, scope string, retryAfter time.Duration, model, message string) {
	if retryAfter <= 0 {
		retryAfter = time.Minute
	}
	maxRetry := 30 * 24 * time.Hour
	if retryAfter > maxRetry {
		retryAfter = maxRetry
	}
	entry := accountRateLimitEntry{ResetTime: time.Now().Add(retryAfter).UnixMilli(), Model: model, Message: message}
	data, _ := json.Marshal(entry)
	_ = s.redis.Set(ctx, accountRateLimitKey(accountID, scope), data, retryAfter).Err()
}

func (s *Service) isRateLimited(ctx context.Context, accountID, scope string) bool {
	entry, ok := s.getRateLimitEntry(ctx, accountID, scope)
	return ok && time.Now().UnixMilli() < entry.ResetTime
}

func (s *Service) getRateLimitEntry(ctx context.Context, accountID, scope string) (accountRateLimitEntry, bool) {
	key := accountRateLimitKey(accountID, scope)
	raw, err := s.redis.Get(ctx, key).Result()
	if err != nil || raw == "" {
		return accountRateLimitEntry{}, false
	}
	var entry accountRateLimitEntry
	if err := json.Unmarshal([]byte(raw), &entry); err != nil || entry.ResetTime <= 0 {
		_ = s.redis.Del(ctx, key).Err()
		return accountRateLimitEntry{}, false
	}
	if time.Now().UnixMilli() >= entry.ResetTime {
		_ = s.redis.Del(ctx, key).Err()
		return accountRateLimitEntry{}, false
	}
	return entry, true
}

func (s *Service) getRateLimitedAccountIDs(ctx context.Context, accountIDs []string, scope string) map[string]struct{} {
	result := map[string]struct{}{}
	if len(accountIDs) == 0 {
		return result
	}
	keys := make([]string, len(accountIDs))
	for i, id := range accountIDs {
		keys[i] = accountRateLimitKey(id, scope)
	}
	values, err := s.redis.MGet(ctx, keys...).Result()
	if err != nil {
		return result
	}
	now := time.Now().UnixMilli()
	for i, raw := range values {
		str, ok := raw.(string)
		if !ok || str == "" {
			continue
		}
		var entry accountRateLimitEntry
		if err := json.Unmarshal([]byte(str), &entry); err != nil || entry.ResetTime <= now {
			_ = s.redis.Del(ctx, keys[i]).Err()
			continue
		}
		result[accountIDs[i]] = struct{}{}
	}
	return result
}

func (s *Service) getMinWaitTime(ctx context.Context, accountIDs []string, scope string) time.Duration {
	if len(accountIDs) == 0 {
		return 0
	}
	minWait := time.Duration(math.MaxInt64)
	for _, accountID := range accountIDs {
		entry, ok := s.getRateLimitEntry(ctx, accountID, scope)
		if !ok {
			return 0
		}
		wait := time.Until(time.UnixMilli(entry.ResetTime))
		if wait < minWait {
			minWait = wait
		}
	}
	if minWait == time.Duration(math.MaxInt64) || minWait < 0 {
		return 0
	}
	return minWait
}

type apiKeyRateLimitResult struct {
	Allowed           bool
	RetryAfterSeconds int
	ExceededWindow    string
	Limit             int
	Current           int
}

const apiKeyRateLimitLua = `
local n = tonumber(ARGV[1])
for i = 1, n do
  local offset = (i - 1) * 3
  local limit = tonumber(ARGV[2 + offset])
  local current = tonumber(redis.call('GET', KEYS[i]) or '0') or 0
  if current >= limit then
    return {0, i, current}
  end
end
for i = 1, n do
  local offset = (i - 1) * 3
  local ttl = tonumber(ARGV[3 + offset])
  local count = redis.call('INCR', KEYS[i])
  if count == 1 then
    redis.call('EXPIRE', KEYS[i], ttl)
  end
end
return {1}
`

var apiKeyRateLimitScript = redis.NewScript(apiKeyRateLimitLua)

func (s *Service) checkAndIncrementAPIKeyRateLimit(ctx context.Context, apiKeyID, model string, rules []auth.RateLimitRule) (apiKeyRateLimitResult, error) {
	rule, ok := s.matchRateLimitRule(model, rules)
	if !ok {
		return apiKeyRateLimitResult{Allowed: true}, nil
	}

	type limitSpec struct {
		window string
		limit  int
		label  string
		secs   int
	}
	limits := []limitSpec{}
	if rule.PerMinute != nil {
		limits = append(limits, limitSpec{window: "min", limit: *rule.PerMinute, label: "minute", secs: 60})
	}
	if rule.PerHour != nil {
		limits = append(limits, limitSpec{window: "hour", limit: *rule.PerHour, label: "hour", secs: 3600})
	}
	if rule.PerDay != nil {
		limits = append(limits, limitSpec{window: "day", limit: *rule.PerDay, label: "day", secs: 86400})
	}
	if len(limits) == 0 {
		return apiKeyRateLimitResult{Allowed: true}, nil
	}

	keys := make([]string, 0, len(limits))
	args := []any{len(limits)}
	for _, limit := range limits {
		keys = append(keys, apiKeyWindowKey(apiKeyID, rule.Target, limit.window, limit.secs))
		args = append(args, limit.limit, limit.secs+1, limit.label)
	}

	res, err := apiKeyRateLimitScript.Run(ctx, s.redis, keys, args...).Slice()
	if err != nil {
		return apiKeyRateLimitResult{Allowed: true}, err
	}
	if len(res) > 0 && toInt(res[0]) == 1 {
		return apiKeyRateLimitResult{Allowed: true}, nil
	}
	idx := toInt(res[1]) - 1
	if idx < 0 || idx >= len(limits) {
		return apiKeyRateLimitResult{Allowed: true}, nil
	}
	exceeded := limits[idx]
	bucket := windowBucket(exceeded.secs)
	retryAfter := maxInt(1, int(bucket+int64(exceeded.secs)-time.Now().Unix()))
	return apiKeyRateLimitResult{Allowed: false, RetryAfterSeconds: retryAfter, ExceededWindow: exceeded.label, Limit: exceeded.limit, Current: toInt(res[2])}, nil
}

func (s *Service) matchRateLimitRule(model string, rules []auth.RateLimitRule) (auth.RateLimitRule, bool) {
	for _, rule := range rules {
		if rule.TargetType == "model" && rule.Target == model {
			return rule, true
		}
	}
	family := s.registry.ModelFamily(model)
	if family != "" {
		for _, rule := range rules {
			if rule.TargetType == "family" && rule.Target == family {
				return rule, true
			}
		}
	}
	return auth.RateLimitRule{}, false
}

func apiKeyWindowKey(apiKeyID, target, window string, windowSeconds int) string {
	return fmt.Sprintf("%s:%s:%s:%s:%d", apiKeyRateLimitPrefix, apiKeyID, target, window, windowBucket(windowSeconds))
}

func windowBucket(windowSeconds int) int64 {
	now := time.Now().Unix()
	return now - (now % int64(windowSeconds))
}

func parseRetryAfter(response *http.Response) time.Duration {
	if value := response.Header.Get("retry-after-ms"); value != "" {
		if parsed, err := strconv.Atoi(value); err == nil && parsed >= 0 {
			return time.Duration(parsed) * time.Millisecond
		}
	}
	if value := response.Header.Get("retry-after"); value != "" {
		if parsed, err := strconv.Atoi(value); err == nil && parsed >= 0 {
			return time.Duration(parsed) * time.Second
		}
	}
	return 0
}

func formatWaitTime(d time.Duration) string {
	seconds := int(math.Ceil(d.Seconds()))
	if seconds < 1 {
		seconds = 1
	}
	hours := seconds / 3600
	minutes := (seconds % 3600) / 60
	secs := seconds % 60
	if hours > 0 {
		if minutes > 0 {
			return fmt.Sprintf("%dh%dm", hours, minutes)
		}
		return fmt.Sprintf("%dh", hours)
	}
	if minutes > 0 {
		if secs > 0 {
			return fmt.Sprintf("%dm%ds", minutes, secs)
		}
		return fmt.Sprintf("%dm", minutes)
	}
	return fmt.Sprintf("%ds", secs)
}

func toInt(value any) int {
	switch v := value.(type) {
	case int:
		return v
	case int64:
		return int(v)
	case uint64:
		return int(v)
	case string:
		parsed, _ := strconv.Atoi(v)
		return parsed
	default:
		return 0
	}
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
