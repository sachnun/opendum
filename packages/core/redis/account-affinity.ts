import { Effect } from "effect";
import { ignore, tryAsync } from "../best-effort.js";
import type { OpendumRedis } from "./client.js";
import { accountAffinityKey } from "./keys.js";

const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

export class AccountAffinity {
  private readonly redis: OpendumRedis;
  private readonly providers: Set<string>;
  private readonly ttlSeconds: number;

  constructor(redis: OpendumRedis, providers: Iterable<string>, ttlSeconds = DEFAULT_TTL_SECONDS) {
    this.redis = redis;
    this.providers = new Set();
    this.ttlSeconds = ttlSeconds;
    for (const provider of providers) {
      const normalized = provider.trim();
      if (normalized) this.providers.add(normalized);
    }
  }

  enabled(provider: string): boolean {
    return this.providers.has(provider.trim());
  }

  lookup(userId: string): Effect.Effect<string> {
    if (userId.trim() === "") return Effect.succeed("");
    return tryAsync(async () => (await this.redis.get(accountAffinityKey(userId))) ?? "", "");
  }

  store(userId: string, accountId: string): Effect.Effect<void> {
    if (userId.trim() === "" || accountId.trim() === "") return Effect.void;
    return ignore(() =>
      this.redis.set(accountAffinityKey(userId), accountId, {
        EX: this.ttlSeconds,
      })
    );
  }
}

export function preferSticky<T>(items: T[], isSticky: (item: T) => boolean): T[] {
  if (items.length === 0) return items;
  const index = items.findIndex(isSticky);
  if (index <= 0) return items;
  const sticky = items[index];
  if (sticky === undefined) return items;
  return [sticky, ...items.slice(0, index), ...items.slice(index + 1)];
}
