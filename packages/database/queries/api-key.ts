import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { db, type DbExecutor } from "../client.js";
import { tryDb } from "../errors.js";
import { proxyApiKey, keyRateLimit } from "../schema/keys.js";

export const keyByHash = Effect.fn("db.keyByHash")(function* (
  keyHash: string,
  database: DbExecutor = db
) {
  const rows = yield* tryDb("keyByHash", () =>
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

export const freshnessById = Effect.fn("db.freshnessById")(function* (
  id: string,
  database: DbExecutor = db
) {
  const rows = yield* tryDb("freshnessById", () =>
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

export const rateLimits = Effect.fn("db.rateLimits")(function* (
  apiKeyId: string,
  database: DbExecutor = db
) {
  return yield* tryDb("rateLimits", () =>
    database
      .select({
        target: keyRateLimit.target,
        targetType: keyRateLimit.targetType,
        perMinute: keyRateLimit.perMinute,
        perHour: keyRateLimit.perHour,
        perDay: keyRateLimit.perDay,
      })
      .from(keyRateLimit)
      .where(eq(keyRateLimit.apiKeyId, apiKeyId))
  );
});

export const touchLastUsed = Effect.fn("db.touchLastUsed")(function* (
  id: string,
  database: DbExecutor = db
) {
  yield* tryDb("touchLastUsed", () =>
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
