import type Redis from "ioredis";
import type { CacheValue, DisabledModelsCacheValue, RateLimitRule } from "./types.js";

export const validationPrefix = "opendum:api-key:validation";
export const lastUsedPrefix = "opendum:api-key:last-used";
export const disabledModelsPrefix = "opendum:user:disabled-models";

export const validTTL = 45 * 1000;
export const invalidTTL = 10 * 1000;
export const lastUsedTTL = 60 * 1000;
export const disabledModelsTTL = 60 * 1000;
export const analyticsVersionPrefix = "opendum:analytics:v1:version";
export const analyticsVersionBumpPrefix = "opendum:analytics:v1:version-bump";
export const analyticsVersionTTL = 30 * 24 * 3600 * 1000;
export const analyticsBumpTTL = 15 * 1000;

export function validationKey(keyHash: string): string {
  return `${validationPrefix}:${keyHash}`;
}

export function lastUsedKey(apiKeyId: string): string {
  return `${lastUsedPrefix}:${apiKeyId}`;
}

export function disabledModelsKey(userId: string): string {
  return `${disabledModelsPrefix}:${userId}`;
}

export function analyticsVersionKey(userId: string): string {
  return `${analyticsVersionPrefix}:${userId}`;
}

export function analyticsVersionBumpKey(userId: string): string {
  return `${analyticsVersionBumpPrefix}:${userId}`;
}

export async function getCachedAPIKeyValidation(redis: Redis | null, keyHash: string): Promise<CacheValue | null> {
  if (!redis) return null;
  try {
    const raw = await redis.get(validationKey(keyHash));
    if (!raw) return null;
    return JSON.parse(raw) as CacheValue;
  } catch {
    return null;
  }
}

export async function setCachedAPIKeyValidation(redis: Redis | null, keyHash: string, value: CacheValue, ttlMs: number): Promise<void> {
  if (!redis) return;
  try {
    await redis.set(validationKey(keyHash), JSON.stringify(value), "PX", ttlMs);
  } catch {
    // ignore
  }
}

export async function invalidateAPIKeyValidation(redis: Redis | null, keyHash: string, apiKeyId: string): Promise<void> {
  if (!redis) return;
  const keys = [validationKey(keyHash)];
  if (apiKeyId !== "") keys.push(lastUsedKey(apiKeyId));
  try {
    await redis.del(...keys);
  } catch {
    // ignore
  }
}

export async function getCachedDisabledModels(redis: Redis | null, userId: string): Promise<string[] | null> {
  if (!redis) return null;
  try {
    const raw = await redis.get(disabledModelsKey(userId));
    if (!raw) return null;
    const value = JSON.parse(raw) as DisabledModelsCacheValue;
    return value.models ?? null;
  } catch {
    return null;
  }
}

export async function setCachedDisabledModels(redis: Redis | null, userId: string, modelList: string[]): Promise<void> {
  if (!redis) return;
  try {
    await redis.set(disabledModelsKey(userId), JSON.stringify({ models: modelList } satisfies DisabledModelsCacheValue), "PX", disabledModelsTTL);
  } catch {
    // ignore
  }
}

export async function bumpAnalyticsCacheVersionThrottled(redis: Redis | null, userId: string): Promise<void> {
  if (!redis || userId === "") return;
  try {
    const bumpKey = analyticsVersionBumpKey(userId);
    const updated = await redis.set(bumpKey, "1", "PX", analyticsBumpTTL, "NX");
    if (updated !== "OK") return;
    const version = await redis.incr(analyticsVersionKey(userId));
    if (version === 1) {
      await redis.expire(analyticsVersionKey(userId), analyticsVersionTTL / 1000);
    }
  } catch {
    // ignore
  }
}

export function serializeRateLimitRules(rules: RateLimitRule[]): RateLimitRule[] {
  return rules;
}
