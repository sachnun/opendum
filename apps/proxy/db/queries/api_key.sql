-- name: GetAPIKeyByHash :one
SELECT id, "userId", "isActive", "expiresAt", "updatedAt", "modelAccessMode", "modelAccessList", "accountAccessMode", "accountAccessList", "roamingEnabled"
FROM proxy_api_key
WHERE "keyHash" = $1
LIMIT 1;

-- name: GetAPIKeyFreshnessByID :one
SELECT id, "isActive", "expiresAt", "updatedAt"
FROM proxy_api_key
WHERE id = $1
LIMIT 1;

-- name: ListAPIKeyRateLimits :many
SELECT target, "targetType", "perMinute", "perHour", "perDay"
FROM proxy_api_key_rate_limit
WHERE "apiKeyId" = $1;

-- name: TouchAPIKeyLastUsed :exec
UPDATE proxy_api_key SET "lastUsedAt" = NOW() WHERE id = $1;

-- name: DeactivateAPIKey :exec
UPDATE proxy_api_key SET "isActive" = FALSE WHERE id = $1;
