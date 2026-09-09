import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Provider } from "@opendum/ai";
import {
    db,
    decrypt,
    encrypt,
    providerAccount,
    type ProviderAccount,
} from "@opendum/database";
import { getRedisClient } from "../redis.js";

const DEFAULT_REFRESH_BUFFER_SECONDS = 3 * 60 * 60;
const REFRESH_LOCK_MS = 2 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 90 * 1000;
const WAIT_FOR_REFRESH_MS = 10 * 1000;
const RELEASE_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

async function loadAccount(id: string): Promise<ProviderAccount | undefined> {
    const [account] = await db
        .select()
        .from(providerAccount)
        .where(eq(providerAccount.id, id))
        .limit(1);
    return account;
}

function accessCredentials(account: ProviderAccount): string {
    return account.apiKey
        ? decrypt(account.apiKey)
        : decrypt(account.accessToken);
}

function refreshBuffer(provider: Provider): number {
    const configured = provider.getRefreshBuffer?.();
    return configured && configured > 0
        ? configured
        : DEFAULT_REFRESH_BUFFER_SECONDS;
}

async function waitForRefreshedAccount(
    original: ProviderAccount,
): Promise<ProviderAccount | undefined> {
    const deadline = Date.now() + WAIT_FOR_REFRESH_MS;
    while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const current = await loadAccount(original.id);
        if (!current) return undefined;
        if (
            current.updatedAt.getTime() > original.updatedAt.getTime() ||
            current.expiresAt.getTime() > original.expiresAt.getTime()
        ) {
            return current;
        }
    }
    return loadAccount(original.id);
}

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
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

export async function credentialsForAccount(
    originalAccount: ProviderAccount,
    provider: Provider,
): Promise<string> {
    if (provider.isAuthless?.()) return "";
    if (originalAccount.apiKey) return accessCredentials(originalAccount);
    if (!provider.refreshCredentials || !originalAccount.refreshToken.trim()) {
        return accessCredentials(originalAccount);
    }

    const dueAt = Date.now() + refreshBuffer(provider) * 1000;
    if (originalAccount.expiresAt.getTime() > dueAt) {
        return accessCredentials(originalAccount);
    }

    const redis = await getRedisClient();
    const lockKey = `opendum:token-refresh:${originalAccount.id}`;
    const lockOwner = randomUUID();
    let locked = false;

    try {
        if (redis) {
            const result = await redis.set(lockKey, lockOwner, {
                NX: true,
                PX: REFRESH_LOCK_MS,
            });
            if (result !== "OK") {
                if (originalAccount.expiresAt.getTime() > Date.now()) {
                    return accessCredentials(originalAccount);
                }
                const refreshedByPeer =
                    await waitForRefreshedAccount(originalAccount);
                if (
                    refreshedByPeer &&
                    refreshedByPeer.expiresAt.getTime() > Date.now()
                ) {
                    return accessCredentials(refreshedByPeer);
                }
                throw new Error(
                    "Token expired while another worker was refreshing it",
                );
            }
            locked = true;
        }

        const account =
            (await loadAccount(originalAccount.id)) ?? originalAccount;
        if (
            account.expiresAt.getTime() >
            Date.now() + refreshBuffer(provider) * 1000
        ) {
            return accessCredentials(account);
        }

        try {
            const refreshToken = decrypt(account.refreshToken);
            if (!refreshToken.trim()) throw new Error("Refresh token is empty");
            const refreshed = await withTimeout(
                provider.refreshCredentials(refreshToken, account),
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
            return refreshed.accessToken;
        } catch (error) {
            if (account.expiresAt.getTime() > Date.now()) {
                return accessCredentials(account);
            }
            throw error;
        }
    } finally {
        if (locked && redis) {
            try {
                await redis.eval(RELEASE_LOCK_SCRIPT, {
                    keys: [lockKey],
                    arguments: [lockOwner],
                });
            } catch {
                // Lock expiry is the safe fallback.
            }
        }
    }
}
