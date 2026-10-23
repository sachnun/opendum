import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { db, type DbExecutor } from "../client.js";
import { tryDb } from "../errors.js";
import { proxyApiKey, proxyApiKeyRateLimit } from "../schema/keys.js";

export const getAPIKeyByHash = Effect.fn("db.getAPIKeyByHash")(function* (
  keyHash: string,
  database: DbExecutor = db
) {
  const rows = yield* tryDb("getAPIKeyByHash", () =>
    database
      .select({
        id: proxyApiKey.id,
        userId: proxyApiKey.userId,
        isActive: proxyApiKey.isActive,
        expiresAt: proxyApiKey.expiresAt,
        updatedAt: proxyApiKey.updatedAt,
        modelAccessMode: proxyApiKey.modelAccessMode,
        modelAccessList: proxyApiKey.modelAccessList,
        accountAccessMode: proxyApiKey.accountAccessMode,
        accountAccessList: proxyApiKey.accountAccessList,
        roamingEnabled: proxyApiKey.roamingEnabled,
      })
      .from(proxyApiKey)
      .where(eq(proxyApiKey.keyHash, keyHash))
      .limit(1)
  );
  return rows[0] ?? null;
});

export const getAPIKeyFreshnessByID = Effect.fn("db.getAPIKeyFreshnessByID")(function* (
  id: string,
  database: DbExecutor = db
) {
  const rows = yield* tryDb("getAPIKeyFreshnessByID", () =>
    database
      .select({
        id: proxyApiKey.id,
        isActive: proxyApiKey.isActive,
        expiresAt: proxyApiKey.expiresAt,
        updatedAt: proxyApiKey.updatedAt,
      })
      .from(proxyApiKey)
      .where(eq(proxyApiKey.id, id))
      .limit(1)
  );
  return rows[0] ?? null;
});

export const listAPIKeyRateLimits = Effect.fn("db.listAPIKeyRateLimits")(function* (
  apiKeyId: string,
  database: DbExecutor = db
) {
  return yield* tryDb("listAPIKeyRateLimits", () =>
    database
      .select({
        target: proxyApiKeyRateLimit.target,
        targetType: proxyApiKeyRateLimit.targetType,
        perMinute: proxyApiKeyRateLimit.perMinute,
        perHour: proxyApiKeyRateLimit.perHour,
        perDay: proxyApiKeyRateLimit.perDay,
      })
      .from(proxyApiKeyRateLimit)
      .where(eq(proxyApiKeyRateLimit.apiKeyId, apiKeyId))
  );
});

export const touchAPIKeyLastUsed = Effect.fn("db.touchAPIKeyLastUsed")(function* (
  id: string,
  database: DbExecutor = db
) {
  yield* tryDb("touchAPIKeyLastUsed", () =>
    database.update(proxyApiKey).set({ lastUsedAt: new Date() }).where(eq(proxyApiKey.id, id))
  );
});

export const deactivateAPIKey = Effect.fn("db.deactivateAPIKey")(function* (
  id: string,
  database: DbExecutor = db
) {
  yield* tryDb("deactivateAPIKey", () =>
    database.update(proxyApiKey).set({ isActive: false }).where(eq(proxyApiKey.id, id))
  );
});
