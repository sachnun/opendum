package proxy

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/opendum/opendum/apps/proxy/internal/auth"
)

const apiKeyRateLimitPrefix = "opendum:api-key-rl"

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
