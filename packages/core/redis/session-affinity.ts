import type { OpendumRedis } from "./client.js";
import { sessionAffinityKey } from "./keys.js";

const DEFAULT_TTL_SECONDS = 2 * 60 * 60;

export class SessionAffinity {
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

  async lookup(userId: string, sessionId: string): Promise<string> {
    if (!validPair(userId, sessionId)) return "";
    try {
      return (await this.redis.get(sessionAffinityKey(userId, sessionId))) ?? "";
    } catch {
      return "";
    }
  }

  async store(userId: string, sessionId: string, accountId: string): Promise<void> {
    if (!validPair(userId, sessionId) || accountId.trim() === "") return;
    try {
      await this.redis.set(sessionAffinityKey(userId, sessionId), accountId, {
        EX: this.ttlSeconds,
      });
    } catch {
      return;
    }
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

function validPair(userId: string, sessionId: string): boolean {
  return userId.trim() !== "" && sessionId.trim() !== "";
}
