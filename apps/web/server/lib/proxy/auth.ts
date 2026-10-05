import { AuthService } from "@opendum/auth";
import type { AccountModelAvailability } from "@opendum/auth";
import type { OpendumRedis } from "@opendum/redis";
import { getRedisClient } from "../redis.ts";
import { registry } from "./models.ts";

const VALIDATION_PREFIX = "opendum:api-key:validation";
const LAST_USED_PREFIX = "opendum:api-key:last-used";
const DISABLED_MODELS_PREFIX = "opendum:user:disabled-models";
const REFRESH_FAIL_COUNT_PREFIX = "opendum:provider-account:refresh-fail-count";

function getApiKeyValidationCacheKey(keyHash: string): string {
  return `${VALIDATION_PREFIX}:${keyHash}`;
}

function getApiKeyLastUsedThrottleKey(apiKeyId: string): string {
  return `${LAST_USED_PREFIX}:${apiKeyId}`;
}

function getDisabledModelsCacheKey(userId: string): string {
  return `${DISABLED_MODELS_PREFIX}:${userId}`;
}

export type { AccountModelAvailability };

const dummyRedis = {} as OpendumRedis;

export async function invalidateDisabledModelsCache(userId: string): Promise<void> {
  try {
    const redis = await getRedisClient();
    await redis.del(getDisabledModelsCacheKey(userId));
  } catch {
    return;
  }
}

export async function clearRefreshFailCount(accountId: string): Promise<void> {
  try {
    const redis = await getRedisClient();
    await redis.del(`${REFRESH_FAIL_COUNT_PREFIX}:${accountId}`);
  } catch {
    return;
  }
}

export async function invalidateApiKeyValidationCache(
  keyHash: string,
  apiKeyId?: string
): Promise<void> {
  try {
    const redis = await getRedisClient();
    const keys = [getApiKeyValidationCacheKey(keyHash)];
    if (apiKeyId) keys.push(getApiKeyLastUsedThrottleKey(apiKeyId));
    await redis.del(keys);
  } catch {
    return;
  }
}

export async function getAccountModelAvailability(
  userId: string,
  options: { includeInactiveAccounts?: boolean } = {}
): Promise<AccountModelAvailability> {
  const service = new AuthService(registry, dummyRedis);
  return service.getAccountModelAvailabilityWithSharing(userId, false, options);
}

export function isModelUsableByAccounts(
  model: string,
  availability: AccountModelAvailability
): boolean {
  const service = new AuthService(registry, dummyRedis);
  return service.isModelUsableByAccounts(model, availability);
}
