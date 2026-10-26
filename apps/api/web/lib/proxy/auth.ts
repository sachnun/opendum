import { Effect } from "effect";
import { AuthService } from "@opendum/auth";
import type { AccountModelAvailability } from "@opendum/auth";
import type { OpendumRedis } from "@opendum/core/redis";
import { getRedisClient } from "@opendum/api/web/lib/redis";
import { fromEffect, fromPromise } from "@opendum/api/web/lib/task";
import { registry } from "@opendum/api/web/lib/proxy/models";

const VALIDATION_PREFIX = "opendum:api-key:validation";
const LAST_USED_PREFIX = "opendum:api-key:last-used";
const DISABLED_MODELS_PREFIX = "opendum:user:disabled-models";
const FAIL_PREFIX = "opendum:provider-account:refresh-fail-count";

function validationKey(keyHash: string): string {
  return `${VALIDATION_PREFIX}:${keyHash}`;
}

function usedKey(apiKeyId: string): string {
  return `${LAST_USED_PREFIX}:${apiKeyId}`;
}

function disabledKey(userId: string): string {
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

export const invalidateDisabled = Effect.fn("invalidateDisabled")(function* (
  userId: string
) {
  yield* deleteKeys((redis) => redis.del(disabledKey(userId)));
});

export const clearFails = Effect.fn("clearFails")(function* (accountId: string) {
  yield* deleteKeys((redis) => redis.del(`${FAIL_PREFIX}:${accountId}`));
});

export const invalidateValidation = Effect.fn("invalidateValidation")(function* (
  keyHash: string,
  apiKeyId?: string
) {
  const keys = [validationKey(keyHash)];
  if (apiKeyId) keys.push(usedKey(apiKeyId));
  yield* deleteKeys((redis) => redis.del(keys));
});

export const modelAvailability = Effect.fn("modelAvailability")(function* (
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
