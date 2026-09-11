-- name: InsertUsageLog :exec
INSERT INTO usage_log (id, "userId", "providerAccountId", "proxyApiKeyId", model, "inputTokens", "outputTokens", "statusCode", duration, "createdAt")
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);

-- name: DebitPointBalance :one
UPDATE user_point_balance SET balance = balance - $1, "updatedAt" = $2 WHERE "userId" = $3 AND balance >= $1 RETURNING balance;

-- name: CreditPointBalance :one
UPDATE user_point_balance SET balance = balance + $1, "updatedAt" = $2 WHERE "userId" = $3 RETURNING balance;

-- name: InsertPointTransaction :exec
INSERT INTO point_transaction (id, "userId", amount, type, "balanceAfter", "idempotencyKey", "usageLogId", "createdAt")
VALUES ($1, $2, $3, $4, $5, $6, $7, $8);

-- name: InsertPointTransactionOnConflictDoNothing :execrows
INSERT INTO point_transaction (id, "userId", amount, type, "balanceAfter", "idempotencyKey", "usageLogId", "createdAt")
VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT ("idempotencyKey") DO NOTHING;

-- name: UpdatePointTransactionBalance :exec
UPDATE point_transaction SET "balanceAfter" = $1 WHERE id = $2;

-- name: InsertPointBalanceOnConflictDoNothing :execrows
INSERT INTO user_point_balance ("userId", balance, "createdAt", "updatedAt")
VALUES ($1, $2, $3, $4) ON CONFLICT ("userId") DO NOTHING;
