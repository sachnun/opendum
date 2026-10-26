import { Effect } from "effect";
import { lastUsed, validationKey, type OpendumRedis } from "@opendum/core/redis";
import { touchLastUsed } from "@opendum/database/queries";
import { ignore, tryAsync } from "@opendum/core/best-effort";
import type { RateLimitRule } from "./types.js";

export const VALID_TTL = 45;
export const INVALID_TTL = 10;
const TOUCH_TTL = 60;

export type Cached = {
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

export class Cache {
  constructor(private readonly redis: OpendumRedis) {}

  get(keyHash: string): Effect.Effect<Cached | null> {
    return tryAsync(async () => {
      const raw = await this.redis.get(validationKey(keyHash));
      if (!raw) return null;
      return JSON.parse(raw) as Cached;
    }, null);
  }

  set(keyHash: string, value: Cached, ttlSeconds: number): Effect.Effect<void> {
    return ignore(() =>
      this.redis.set(validationKey(keyHash), JSON.stringify(value), {
        EX: Math.max(1, Math.round(ttlSeconds)),
      })
    );
  }

  touch(apiKeyId: string): Effect.Effect<void> {
    if (!apiKeyId) return Effect.void;
    return ignore(async () => {
      const updated = await this.redis.set(lastUsed(apiKeyId), "1", {
        NX: true,
        EX: TOUCH_TTL,
      });
      if (!updated) return;
      await touchLastUsed(apiKeyId);
    });
  }

  invalidate(keyHash: string, apiKeyId: string): Effect.Effect<void> {
    const keys = [validationKey(keyHash)];
    if (apiKeyId) keys.push(lastUsed(apiKeyId));
    return ignore(() => this.redis.del(keys));
  }
}
