-- name: BumpAccountRequestCount :exec
UPDATE provider_account
SET "lastUsedAt" = $1, "requestCount" = "requestCount" + 1
WHERE id = $2;

-- name: GetAccountHealthState :one
SELECT id, status, "disabledUntil", "consecutiveErrors"
FROM provider_account
WHERE id = $1
LIMIT 1;

-- name: SetAccountHealthFailed :exec
UPDATE provider_account
SET "consecutiveErrors" = $1, status = $2, "statusChangedAt" = $3
WHERE id = $4;

-- name: SetAccountCooldown :exec
UPDATE provider_account
SET status = $1, "statusChangedAt" = $2, "consecutiveErrors" = $3, "disabledUntil" = $4
WHERE id = $5;

-- name: SetAccountActive :exec
UPDATE provider_account
SET status = $1, "statusChangedAt" = $2, "consecutiveErrors" = $3, "disabledUntil" = NULL
WHERE id = $4;

-- name: SetAccountUsageLimited :exec
UPDATE provider_account
SET "disabledUntil" = $1, status = $2, "statusChangedAt" = $3
WHERE id = $4;

-- name: RecordRequestError :exec
UPDATE provider_account
SET "errorCount" = "errorCount" + 1, "lastErrorAt" = $1, "lastErrorCode" = $2
WHERE id = $3;

-- name: MarkAccountSuccess :exec
UPDATE provider_account
SET "successCount" = "successCount" + 1, "lastSuccessAt" = $1
WHERE id = $2;

-- name: MarkAccountRecoveredByRotation :exec
UPDATE provider_account
SET "lastRecoveredByRotationAt" = $1
WHERE id = $2 AND "lastErrorAt" <= $3;

-- name: ListModelHealthByAccounts :many
SELECT id, "providerAccountId", model, "consecutiveErrors", status, "statusChangedAt", "lastErrorAt", "lastErrorCode", "lastSuccessAt", "unhealthyCountUpdatedAt", "createdAt", "updatedAt", "quotaLockedUntil", "quotaLockReason"
FROM provider_account_model_health
WHERE "providerAccountId" = ANY(sqlc.arg(account_ids)::text[])
  AND model = ANY(sqlc.arg(models)::text[]);

-- name: ListModelHealthByAccount :many
SELECT id, "providerAccountId", model, "consecutiveErrors", status, "statusChangedAt", "lastErrorAt", "lastErrorCode", "lastSuccessAt", "unhealthyCountUpdatedAt", "createdAt", "updatedAt", "quotaLockedUntil", "quotaLockReason"
FROM provider_account_model_health
WHERE "providerAccountId" = $1;

-- name: GetModelHealth :one
SELECT id, "providerAccountId", model, "consecutiveErrors", status, "statusChangedAt", "lastErrorAt", "lastErrorCode", "lastSuccessAt", "unhealthyCountUpdatedAt", "createdAt", "updatedAt", "quotaLockedUntil", "quotaLockReason"
FROM provider_account_model_health
WHERE "providerAccountId" = $1 AND model = $2
LIMIT 1;

-- name: UpdateModelHealthCounters :exec
UPDATE provider_account_model_health
SET "consecutiveErrors" = $1, "unhealthyCountUpdatedAt" = $2
WHERE id = $3;

-- name: UpdateModelHealthStatus :exec
UPDATE provider_account_model_health
SET "consecutiveErrors" = $1, "unhealthyCountUpdatedAt" = $2, status = $3, "statusChangedAt" = $4
WHERE id = $5;

-- name: InsertModelHealth :exec
INSERT INTO provider_account_model_health (id, "providerAccountId", model, "consecutiveErrors", status, "lastErrorAt", "lastErrorCode", "unhealthyCountUpdatedAt", "createdAt", "updatedAt")
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);

-- name: MarkUsageLimitedHealth :exec
UPDATE provider_account_model_health
SET status = $1, "statusChangedAt" = $2, "consecutiveErrors" = $3, "lastErrorAt" = $2, "unhealthyCountUpdatedAt" = $2
WHERE "providerAccountId" = $4 AND model = $5;

-- name: UpdateModelHealthSuccess :exec
UPDATE provider_account_model_health
SET "consecutiveErrors" = $1, "lastSuccessAt" = $2, "unhealthyCountUpdatedAt" = $3
WHERE id = $4;

-- name: UpdateModelHealthSuccessWithStatus :exec
UPDATE provider_account_model_health
SET "consecutiveErrors" = $1, "lastSuccessAt" = $2, "unhealthyCountUpdatedAt" = $3, status = $4, "statusChangedAt" = $5
WHERE id = $6;

-- name: UpdateModelHealthFailure :exec
UPDATE provider_account_model_health
SET "consecutiveErrors" = $1, "lastErrorAt" = $2, "lastErrorCode" = $3, "unhealthyCountUpdatedAt" = $4
WHERE id = $5;

-- name: UpdateModelHealthFailureWithStatus :exec
UPDATE provider_account_model_health
SET "consecutiveErrors" = $1, "lastErrorAt" = $2, "lastErrorCode" = $3, "unhealthyCountUpdatedAt" = $4, status = $5, "statusChangedAt" = $6
WHERE id = $7;

-- name: LockModelQuota :exec
INSERT INTO provider_account_model_health (id, "providerAccountId", model, "consecutiveErrors", status, "quotaLockedUntil", "quotaLockReason", "createdAt", "updatedAt")
VALUES ($1, $2, $3, 0, 'active', $4, $5, $6, $7)
ON CONFLICT ("providerAccountId", model) DO UPDATE
SET "quotaLockedUntil" = EXCLUDED."quotaLockedUntil",
    "quotaLockReason" = EXCLUDED."quotaLockReason",
    "updatedAt" = EXCLUDED."updatedAt";

-- name: ClearModelQuotaLock :exec
UPDATE provider_account_model_health
SET "quotaLockedUntil" = NULL, "quotaLockReason" = NULL
WHERE "providerAccountId" = $1 AND model = $2 AND "quotaLockedUntil" IS NOT NULL;
