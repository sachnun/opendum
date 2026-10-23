import { Effect } from "effect";
import { AuthService } from "@opendum/auth";
import type { AccountModelAvailability } from "@opendum/auth";
import type { OpendumRedis } from "@opendum/core/redis";
import { getRedisClient } from "../redis.js";
import { fromEffect, fromPromise } from "../task.js";
import { registry } from "./models.js";

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

function deleteKeys(build: (redis: OpendumRedis) => Promise<unknown>) {
  return Effect.gen(function* () {
    const redis = yield* getRedisClient();
    yield* fromPromise(() => build(redis), "Failed to invalidate cache");
  }).pipe(Effect.ignore);
}

export const invalidateDisabledModelsCache = Effect.fn("invalidateDisabledModelsCache")(function* (
  userId: string
) {
  yield* deleteKeys((redis) => redis.del(getDisabledModelsCacheKey(userId)));
});

export const clearRefreshFailCount = Effect.fn("clearRefreshFailCount")(function* (accountId: string) {
  yield* deleteKeys((redis) => redis.del(`${REFRESH_FAIL_COUNT_PREFIX}:${accountId}`));
});

export const invalidateApiKeyValidationCache = Effect.fn("invalidateApiKeyValidationCache")(function* (
  keyHash: string,
  apiKeyId?: string
) {
  const keys = [getApiKeyValidationCacheKey(keyHash)];
  if (apiKeyId) keys.push(getApiKeyLastUsedThrottleKey(apiKeyId));
  yield* deleteKeys((redis) => redis.del(keys));
});

export const getAccountModelAvailability = Effect.fn("getAccountModelAvailability")(function* (
  userId: string,
  options: { includeInactiveAccounts?: boolean } = {}
) {
  const service = new AuthService(registry, dummyRedis);
  return yield* fromEffect(
    service.availability(userId, false, options),
    "Failed to load account availability"
  );
});

export function usable(model: string, availability: AccountModelAvailability): boolean {
  const service = new AuthService(registry, dummyRedis);
  return service.usable(model, availability);
}
