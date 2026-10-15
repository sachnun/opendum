import { Effect } from "effect";
import { apiKeyLastUsedKey, apiKeyValidationKey, type OpendumRedis } from "@opendum/core/redis";
import { touchAPIKeyLastUsed } from "@opendum/database/queries";
import { ignoringErrors, tryAsync } from "@opendum/core/best-effort";
import type { RateLimitRule } from "./types.js";

export const VALID_CACHE_TTL_SECONDS = 45;
export const INVALID_CACHE_TTL_SECONDS = 10;
const LAST_USED_TTL_SECONDS = 60;

export type CachedAPIKeyValidation = {
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

export class APIKeyCache {
  constructor(private readonly redis: OpendumRedis) {}

  get(keyHash: string): Effect.Effect<CachedAPIKeyValidation | null> {
    return tryAsync(async () => {
      const raw = await this.redis.get(apiKeyValidationKey(keyHash));
      if (!raw) return null;
      return JSON.parse(raw) as CachedAPIKeyValidation;
    }, null);
  }

  set(keyHash: string, value: CachedAPIKeyValidation, ttlSeconds: number): Effect.Effect<void> {
    return ignoringErrors(() =>
      this.redis.set(apiKeyValidationKey(keyHash), JSON.stringify(value), {
        EX: Math.max(1, Math.round(ttlSeconds)),
      })
    );
  }

  touch(apiKeyId: string): Effect.Effect<void> {
    if (!apiKeyId) return Effect.void;
    return ignoringErrors(async () => {
      const updated = await this.redis.set(apiKeyLastUsedKey(apiKeyId), "1", {
        NX: true,
        EX: LAST_USED_TTL_SECONDS,
      });
      if (!updated) return;
      await touchAPIKeyLastUsed(apiKeyId);
    });
  }

  invalidate(keyHash: string, apiKeyId: string): Effect.Effect<void> {
    const keys = [apiKeyValidationKey(keyHash)];
    if (apiKeyId) keys.push(apiKeyLastUsedKey(apiKeyId));
    return ignoringErrors(() => this.redis.del(keys));
  }
}
