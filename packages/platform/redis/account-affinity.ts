import { Effect } from "effect";
import type { OpendumRedis } from "@opendum/platform/redis/client";
import { affinityKey } from "@opendum/platform/redis/keys";

const DEFAULT_TTL_SECONDS = 24 * 60 * 60;
const LOG_INTERVAL_MS = 30_000;

export const OWN_ACCOUNT_SCOPE = "";
export const SHARED_ACCOUNT_SCOPE = "shared";

export class AccountAffinity {
  private readonly redis: OpendumRedis;
  private readonly providers: Set<string>;
  private readonly ttlSeconds: number;
  private lastLogAt = 0;

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

  lookup(userId: string, scope = OWN_ACCOUNT_SCOPE): Effect.Effect<string> {
    if (userId.trim() === "") return Effect.succeed("");
    return Effect.tryPromise({
      try: async () => (await this.redis.get(affinityKey(userId, scope))) ?? "",
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }).pipe(
      Effect.tapError((error) => this.logFailure("lookup", error, scope)),
      Effect.orElseSucceed(() => "")
    );
  }

  store(userId: string, accountId: string, scope = OWN_ACCOUNT_SCOPE): Effect.Effect<void> {
    if (userId.trim() === "" || accountId.trim() === "") return Effect.void;
    return Effect.tryPromise({
      try: async () => {
        await this.redis.set(affinityKey(userId, scope), accountId, { EX: this.ttlSeconds });
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }).pipe(
      Effect.tapError((error) => this.logFailure("store", error, scope)),
      Effect.orElseSucceed(() => undefined)
    );
  }

  private logFailure(action: string, error: Error, scope: string): Effect.Effect<void> {
    const now = Date.now();
    if (now - this.lastLogAt < LOG_INTERVAL_MS) return Effect.void;
    this.lastLogAt = now;
    return Effect.logWarning("account affinity unavailable, routing without it").pipe(
      Effect.annotateLogs({ action, scope, error: error.message })
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
