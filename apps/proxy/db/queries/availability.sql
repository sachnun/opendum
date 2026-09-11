-- name: ListDisabledModelsByUser :many
SELECT model FROM disabled_model WHERE "userId" = $1;

-- name: ListActiveAccountTiers :many
SELECT id, provider, tier FROM provider_account
WHERE "userId" = $1
  AND "isActive"
  AND ("disabledUntil" IS NULL OR "disabledUntil" <= $2);

-- name: ListDisabledModelsByAccounts :many
SELECT "providerAccountId", model FROM provider_account_disabled_model
WHERE "providerAccountId" = ANY(sqlc.arg(account_ids)::text[]);

-- name: ListSharedAccounts :many
SELECT provider_account.id, provider_account.provider, provider_account.tier
FROM provider_account
JOIN user_sharing_setting ON user_sharing_setting."userId" = provider_account."userId"
WHERE provider_account."userId" <> $1
  AND user_sharing_setting.enabled
  AND provider_account."isActive"
  AND (provider_account."disabledUntil" IS NULL OR provider_account."disabledUntil" <= $2);

-- name: ListDisabledAccountIDs :many
SELECT "providerAccountId" FROM provider_account_disabled_model
WHERE "providerAccountId" = ANY(sqlc.arg(account_ids)::text[])
  AND model = ANY(sqlc.arg(models)::text[]);
