import type Redis from "ioredis";

const defaultTTL = 30 * 60 * 1000; // 30 minutes
const keyPrefix = "opendum:session-affinity";

export class Affinity {
  private redis: Redis | null;
  private ttl: number;
  private providers: Set<string>;

  constructor(redis: Redis | null, providers: string[]) {
    this.redis = redis;
    this.ttl = defaultTTL;
    this.providers = new Set(providers.map((p) => p.trim()).filter(Boolean));
  }

  enabled(provider: string): boolean {
    return this.providers.has(provider.trim());
  }

  async lookup(userID: string, sessionID: string): Promise<string> {
    if (!this.redis || !validPair(userID, sessionID)) return "";
    try {
      return (await this.redis.get(affinityKey(userID, sessionID))) ?? "";
    } catch {
      return "";
    }
  }

  async store(userID: string, sessionID: string, accountID: string): Promise<void> {
    if (!this.redis || !validPair(userID, sessionID) || accountID.trim() === "") return;
    try {
      await this.redis.set(affinityKey(userID, sessionID), accountID, "PX", this.ttl);
    } catch {
      // ignore
    }
  }
}

export function preferSticky<T>(items: T[], isSticky: (item: T) => boolean): T[] {
  if (items.length === 0 || !isSticky) return items;
  for (let i = 0; i < items.length; i++) {
    if (isSticky(items[i])) {
      if (i === 0) return items;
      return [items[i], ...items.slice(0, i), ...items.slice(i + 1)];
    }
  }
  return items;
}

function affinityKey(userID: string, sessionID: string): string {
  return `${keyPrefix}:${userID}:${sessionID}`;
}

function validPair(userID: string, sessionID: string): boolean {
  return userID.trim() !== "" && sessionID.trim() !== "";
}
