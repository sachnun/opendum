import type { RedisClientType } from "redis";

const DEFAULT_TTL_SECONDS = 2 * 60 * 60; // 2 hours
const KEY_PREFIX = "opendum:session-affinity";

export class SessionAffinity {
  constructor(
    private redis: RedisClientType | null,
    private enabledProviders: Set<string> = new Set(["antigravity", "codex"])
  ) {}

  isEnabled(provider: string): boolean {
    return this.enabledProviders.has(provider.trim().toLowerCase());
  }

  async lookup(userId: string, sessionId: string): Promise<string | null> {
    if (!this.redis || !userId.trim() || !sessionId.trim()) return null;
    try {
      const key = `${KEY_PREFIX}:${userId}:${sessionId}`;
      return await this.redis.get(key);
    } catch {
      return null;
    }
  }

  async store(userId: string, sessionId: string, accountId: string): Promise<void> {
    if (!this.redis || !userId.trim() || !sessionId.trim() || !accountId.trim()) return;
    try {
      const key = `${KEY_PREFIX}:${userId}:${sessionId}`;
      await this.redis.set(key, accountId, { EX: DEFAULT_TTL_SECONDS });
    } catch {
      // ignore
    }
  }

  preferStickyAccount<T extends { id: string }>(
    accounts: T[],
    stickyAccountId?: string | null
  ): T[] {
    if (!stickyAccountId || accounts.length <= 1) return accounts;

    const index = accounts.findIndex((a) => a.id === stickyAccountId);
    if (index <= 0) return accounts;

    const sticky = accounts[index]!;
    return [sticky, ...accounts.slice(0, index), ...accounts.slice(index + 1)];
  }
}
