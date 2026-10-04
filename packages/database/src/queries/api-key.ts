import { eq } from "drizzle-orm";
import { db, type Database } from "../client.js";
import { proxyApiKey, proxyApiKeyRateLimit } from "../schema/keys.js";

export async function getAPIKeyByHash(keyHash: string, database: Database = db) {
  const [row] = await database
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
    .limit(1);
  return row ?? null;
}

export async function getAPIKeyFreshnessByID(id: string, database: Database = db) {
  const [row] = await database
    .select({
      id: proxyApiKey.id,
      isActive: proxyApiKey.isActive,
      expiresAt: proxyApiKey.expiresAt,
      updatedAt: proxyApiKey.updatedAt,
    })
    .from(proxyApiKey)
    .where(eq(proxyApiKey.id, id))
    .limit(1);
  return row ?? null;
}

export async function listAPIKeyRateLimits(apiKeyId: string, database: Database = db) {
  return database
    .select({
      target: proxyApiKeyRateLimit.target,
      targetType: proxyApiKeyRateLimit.targetType,
      perMinute: proxyApiKeyRateLimit.perMinute,
      perHour: proxyApiKeyRateLimit.perHour,
      perDay: proxyApiKeyRateLimit.perDay,
    })
    .from(proxyApiKeyRateLimit)
    .where(eq(proxyApiKeyRateLimit.apiKeyId, apiKeyId));
}

export async function touchAPIKeyLastUsed(id: string, database: Database = db) {
  await database.update(proxyApiKey).set({ lastUsedAt: new Date() }).where(eq(proxyApiKey.id, id));
}

export async function deactivateAPIKey(id: string, database: Database = db) {
  await database.update(proxyApiKey).set({ isActive: false }).where(eq(proxyApiKey.id, id));
}
