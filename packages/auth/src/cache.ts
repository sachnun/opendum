import type { Registry } from "@opendum/models/runtime";
import {
  analyticsVersionBumpKey,
  analyticsVersionKey,
  apiKeyLastUsedKey,
  apiKeyValidationKey,
  disabledModelsKey,
  type OpendumRedis,
} from "@opendum/redis";
import { listAPIKeyRateLimits, touchAPIKeyLastUsed } from "@opendum/database/queries";
import type { RateLimitRule } from "#auth/types.ts";
import { normalizeAccessMode, normalizeAccountList, normalizeDisabledModelList } from "#auth/helpers.ts";

const LAST_USED_TTL_SECONDS = 60;
const DISABLED_MODELS_TTL_SECONDS = 60;

export type CacheValue = {
  valid: boolean;
  userId?: string;
  apiKeyId?: string;
  modelAccessMode?: string;
  modelAccessList?: string[];
  accountAccessMode?: string;
  accountAccessList?: string[];
  roamingEnabled?: boolean;
  expiresAtMs?: number;
  rateLimitRules?: RateLimitRule[];
  error?: string;
};

export async function getRateLimitRules(apiKeyId: string): Promise<RateLimitRule[]> {
  const rows = await listAPIKeyRateLimits(apiKeyId);
  return rows.map((row) => ({
    target: row.target,
    targetType: row.targetType === "family" ? "family" : "model",
    perMinute: row.perMinute,
    perHour: row.perHour,
    perDay: row.perDay,
  }));
}

export function resultFromCache(cached: CacheValue) {
  return {
    valid: true as const,
    userId: cached.userId ?? "",
    apiKeyId: cached.apiKeyId ?? "",
    modelAccessMode: normalizeAccessMode(cached.modelAccessMode ?? ""),
    modelAccessList: normalizeAccountList(cached.modelAccessList ?? []),
    accountAccessMode: normalizeAccessMode(cached.accountAccessMode ?? ""),
    accountAccessList: normalizeAccountList(cached.accountAccessList ?? []),
    roamingEnabled: Boolean(cached.roamingEnabled),
    rateLimitRules: cached.rateLimitRules ?? [],
    error: "",
  };
}

export async function getCachedAPIKeyValidation(redis: OpendumRedis, keyHash: string): Promise<CacheValue | null> {
  try {
    const raw = await redis.get(apiKeyValidationKey(keyHash));
    if (!raw) return null;
    return JSON.parse(raw) as CacheValue;
  } catch {
    return null;
  }
}

export async function setCachedAPIKeyValidation(
  redis: OpendumRedis,
  keyHash: string,
  value: CacheValue,
  ttlSeconds: number
): Promise<void> {
  try {
    await redis.set(apiKeyValidationKey(keyHash), JSON.stringify(value), {
      EX: Math.max(1, Math.round(ttlSeconds)),
    });
  } catch {
    return;
  }
}

export async function touchAPIKeyLastUsedThrottled(redis: OpendumRedis, apiKeyId: string): Promise<void> {
  if (!apiKeyId) return;
  try {
    const updated = await redis.set(apiKeyLastUsedKey(apiKeyId), "1", {
      NX: true,
      EX: LAST_USED_TTL_SECONDS,
    });
    if (!updated) return;
    await touchAPIKeyLastUsed(apiKeyId);
  } catch {
    return;
  }
}

export async function getCachedDisabledModels(
  redis: OpendumRedis,
  registry: Registry,
  userId: string
): Promise<string[] | null> {
  try {
    const raw = await redis.get(disabledModelsKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { models?: string[] };
    return normalizeDisabledModelList(registry, parsed.models ?? []);
  } catch {
    return null;
  }
}

export async function setCachedDisabledModels(
  redis: OpendumRedis,
  registry: Registry,
  userId: string,
  models: string[]
): Promise<void> {
  try {
    await redis.set(
      disabledModelsKey(userId),
      JSON.stringify({ models: normalizeDisabledModelList(registry, models) }),
      { EX: DISABLED_MODELS_TTL_SECONDS }
    );
  } catch {
    return;
  }
}

export async function bumpAnalyticsCacheVersionThrottled(redis: OpendumRedis, userId: string): Promise<void> {
  if (!userId) return;
  try {
    const updated = await redis.set(analyticsVersionBumpKey(userId), "1", { NX: true, EX: 15 });
    if (!updated) return;
    const version = await redis.incr(analyticsVersionKey(userId));
    if (version === 1) {
      await redis.expire(analyticsVersionKey(userId), 30 * 24 * 60 * 60);
    }
  } catch {
    return;
  }
}
