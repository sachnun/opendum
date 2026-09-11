-- name: ListEligibleAccounts :many
SELECT id, "userId", provider, tier, status, "lastUsedAt", "createdAt", "accountId", "disabledUntil"
FROM provider_account
WHERE "userId" = sqlc.arg(user_id)
  AND provider = ANY(sqlc.arg(providers)::text[])
  AND "isActive"
  AND ("disabledUntil" IS NULL OR "disabledUntil" <= sqlc.arg(now))
  AND (CARDINALITY(sqlc.arg(exclude_ids)::text[]) = 0 OR NOT (id = ANY(sqlc.arg(exclude_ids)::text[])))
  AND (CARDINALITY(sqlc.arg(exclude_providers)::text[]) = 0 OR NOT (provider = ANY(sqlc.arg(exclude_providers)::text[])))
  AND CASE WHEN sqlc.arg(use_whitelist)::boolean THEN id = ANY(sqlc.arg(account_ids)::text[]) WHEN sqlc.arg(use_blacklist)::boolean THEN NOT (id = ANY(sqlc.arg(account_ids)::text[])) ELSE TRUE END
ORDER BY status ASC, "lastUsedAt" ASC NULLS FIRST, "createdAt" ASC;

-- name: ListSharedEligibleAccounts :many
SELECT provider_account.id, provider_account."userId", provider_account.provider, provider_account.tier, provider_account.status, provider_account."lastUsedAt", provider_account."createdAt", provider_account."accountId", provider_account."disabledUntil"
FROM provider_account
JOIN user_sharing_setting ON user_sharing_setting."userId" = provider_account."userId"
WHERE provider_account."userId" <> sqlc.arg(user_id)
  AND user_sharing_setting.enabled
  AND provider_account.provider = ANY(sqlc.arg(providers)::text[])
  AND provider_account."isActive"
  AND (provider_account."disabledUntil" IS NULL OR provider_account."disabledUntil" <= sqlc.arg(now))
  AND (CARDINALITY(sqlc.arg(exclude_ids)::text[]) = 0 OR NOT (provider_account.id = ANY(sqlc.arg(exclude_ids)::text[])))
  AND (CARDINALITY(sqlc.arg(exclude_providers)::text[]) = 0 OR NOT (provider_account.provider = ANY(sqlc.arg(exclude_providers)::text[])))
ORDER BY provider_account.status ASC, provider_account."lastUsedAt" ASC NULLS FIRST, provider_account."createdAt" ASC;

-- name: GetQuotaAccount :one
SELECT id, "userId", provider, name, "accessToken", "refreshToken", "expiresAt", "apiKey", "projectId", tier, "accountId", email, "isActive", "lastUsedAt"
FROM provider_account
WHERE id = $1 AND "userId" = $2 AND provider = $3
LIMIT 1;

-- name: ListExpiringRefreshableAccounts :many
SELECT id, "userId", provider, "accessToken", "refreshToken", "expiresAt", "accountId", "projectId", tier, email, "isActive"
FROM provider_account
WHERE "isActive"
  AND ("disabledUntil" IS NULL OR "disabledUntil" <= sqlc.arg(now))
  AND provider = sqlc.arg(provider)
  AND "refreshToken" <> ''
  AND "expiresAt" <= sqlc.arg(expires_before)
ORDER BY "expiresAt" ASC
LIMIT sqlc.arg(batch_limit);

-- name: GetAccountCredentialsByID :one
SELECT id, "userId", provider, "accessToken", "refreshToken", "expiresAt", "accountId", "projectId", tier, email, "isActive"
FROM provider_account
WHERE id = $1
LIMIT 1;

-- name: GetAccountOwnerUserID :one
SELECT "userId" FROM provider_account WHERE id = $1 LIMIT 1;

-- name: UpdateRefreshedCredentials :exec
UPDATE provider_account
SET "accessToken" = $1, "refreshToken" = $2, "expiresAt" = $3, "projectId" = $4, tier = $5, email = $6, "accountId" = $7, "updatedAt" = $8
WHERE id = $9;

-- name: RecordAccountError :exec
UPDATE provider_account
SET "errorCount" = "errorCount" + 1, "lastErrorAt" = $1, "lastErrorCode" = $2, "updatedAt" = $1
WHERE id = $3;

-- name: DisableFailedAccount :execrows
UPDATE provider_account
SET "isActive" = FALSE, status = $1, "statusChangedAt" = $2, "updatedAt" = $2
WHERE id = $3 AND "isActive";

-- name: UpdateCodexAccountID :exec
UPDATE provider_account SET "accountId" = $1 WHERE id = $2;

-- name: UpdateAntigravityAccountInfo :exec
UPDATE provider_account SET "projectId" = $1, tier = $2, email = $3 WHERE id = $4;

-- name: GetForcedAccount :one
SELECT id, "userId", provider, tier, status, "lastUsedAt", "createdAt", "accountId", "isActive", "disabledUntil"
FROM provider_account
WHERE id = $1 AND "userId" = $2
LIMIT 1;
