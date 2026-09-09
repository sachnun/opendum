import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { RedisClientType } from "redis";
import { db, providerAccount, decrypt, encrypt } from "@opendum/database";
import type { Provider, ProviderRegistry } from "@opendum/ai";

const DEFAULT_REFRESH_BUFFER_SECONDS = 3 * 60 * 60;
const REFRESH_LOCK_MS = 2 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 90 * 1000;
const MAX_REFRESH_ACCOUNTS = 500;
const REFRESH_CONCURRENCY = 3;
const RELEASE_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export class TokenRefresherWorker {
    private timer: NodeJS.Timeout | null = null;
    private running = false;

    constructor(
        private providers: ProviderRegistry,
        private intervalSeconds: number,
        private redis: RedisClientType | null,
    ) {}

    start() {
        if (this.intervalSeconds <= 0 || this.timer) return;

        void this.runRefreshCycle().catch((err) => {
            console.error("Initial token refresher cycle failed:", err);
        });
        this.timer = setInterval(() => {
            void this.runRefreshCycle().catch((err) => {
                console.error("Token refresher worker cycle failed:", err);
            });
        }, this.intervalSeconds * 1000);
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    async runRefreshCycle() {
        if (this.running) return;
        this.running = true;
        try {
            const latestDue = new Date(
                Date.now() + DEFAULT_REFRESH_BUFFER_SECONDS * 1000,
            );
            const accounts = await db
                .select()
                .from(providerAccount)
                .where(
                    sql`${providerAccount.refreshToken} <> '' AND ${providerAccount.expiresAt} <= ${latestDue} AND (${providerAccount.disabledUntil} IS NULL OR ${providerAccount.disabledUntil} <= NOW())`,
                )
                .orderBy(
                    sql`${providerAccount.isActive} DESC`,
                    sql`${providerAccount.expiresAt} ASC`,
                )
                .limit(MAX_REFRESH_ACCOUNTS);

            for (
                let index = 0;
                index < accounts.length;
                index += REFRESH_CONCURRENCY
            ) {
                await Promise.all(
                    accounts
                        .slice(index, index + REFRESH_CONCURRENCY)
                        .map((account) => this.refreshAccount(account.id)),
                );
            }
        } finally {
            this.running = false;
        }
    }

    private async refreshAccount(accountId: string): Promise<void> {
        const lockKey = `opendum:token-refresh:${accountId}`;
        const lockOwner = randomUUID();
        let locked = false;

        try {
            if (this.redis) {
                const result = await this.redis.set(lockKey, lockOwner, {
                    NX: true,
                    PX: REFRESH_LOCK_MS,
                });
                if (result !== "OK") return;
                locked = true;
            }

            const [account] = await db
                .select()
                .from(providerAccount)
                .where(eq(providerAccount.id, accountId))
                .limit(1);
            if (!account || !account.refreshToken.trim()) return;
            if (
                account.disabledUntil &&
                account.disabledUntil.getTime() > Date.now()
            ) {
                return;
            }

            const provider = this.providers.get(account.provider);
            if (!provider?.refreshCredentials) return;
            const bufferSeconds = this.refreshBuffer(provider);
            if (
                account.expiresAt.getTime() >
                Date.now() + bufferSeconds * 1000
            ) {
                return;
            }

            const rawRefreshToken = decrypt(account.refreshToken);
            if (!rawRefreshToken.trim()) return;
            const refreshed = await this.withTimeout(
                provider.refreshCredentials(rawRefreshToken, account),
            );
            if (!refreshed.accessToken?.trim() || !refreshed.expiresAt) {
                throw new Error(
                    "Provider returned incomplete refreshed credentials",
                );
            }

            const updates: Record<string, unknown> = {
                accessToken: encrypt(refreshed.accessToken),
                refreshToken: refreshed.refreshToken
                    ? encrypt(refreshed.refreshToken)
                    : account.refreshToken,
                expiresAt: refreshed.expiresAt,
                updatedAt: new Date(),
            };
            if (refreshed.projectId !== undefined)
                updates.projectId = refreshed.projectId;
            if (refreshed.tier !== undefined) updates.tier = refreshed.tier;
            if (refreshed.email !== undefined) updates.email = refreshed.email;
            if (refreshed.accountId !== undefined)
                updates.accountId = refreshed.accountId;

            await db
                .update(providerAccount)
                .set(updates)
                .where(eq(providerAccount.id, account.id));
        } catch (error) {
            console.warn(
                `Background token refresh failed for account ${accountId}:`,
                error,
            );
        } finally {
            if (locked && this.redis) {
                try {
                    await this.redis.eval(RELEASE_LOCK_SCRIPT, {
                        keys: [lockKey],
                        arguments: [lockOwner],
                    });
                } catch {
                    // The lock expires automatically; never delete another worker's lock.
                }
            }
        }
    }

    private refreshBuffer(provider: Provider): number {
        const configured = provider.getRefreshBuffer?.();
        return configured && configured > 0
            ? configured
            : DEFAULT_REFRESH_BUFFER_SECONDS;
    }

    private async withTimeout<T>(promise: Promise<T>): Promise<T> {
        let timer: NodeJS.Timeout | undefined;
        try {
            return await Promise.race([
                promise,
                new Promise<never>((_, reject) => {
                    timer = setTimeout(
                        () => reject(new Error("Token refresh timed out")),
                        REFRESH_TIMEOUT_MS,
                    );
                }),
            ]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }
}
