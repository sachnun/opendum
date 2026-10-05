import { randomUUID } from "node:crypto";

import {
  REFRESH_FAIL_COUNT_PREFIX,
  TOKEN_REFRESH_LOCK_PREFIX,
  TOKEN_REFRESH_LOCK_TTL_SECONDS,
} from "./service-constants.ts";
import type { ProxyDeps } from "./service-deps.ts";

export async function acquireRefreshLock(
  deps: ProxyDeps,
  accountId: string
): Promise<{ value: string; acquired: boolean }> {
  const value = randomUUID();
  try {
    const result = await deps.redis.set(`${TOKEN_REFRESH_LOCK_PREFIX}${accountId}`, value, {
      NX: true,
      EX: TOKEN_REFRESH_LOCK_TTL_SECONDS,
    });
    return { value, acquired: Boolean(result) };
  } catch {
    return { value, acquired: true };
  }
}

export async function releaseRefreshLock(deps: ProxyDeps, accountId: string, value: string): Promise<void> {
  try {
    await deps.redis.del(`${TOKEN_REFRESH_LOCK_PREFIX}${accountId}`);
  } catch {
    void value;
  }
}

export async function clearRefreshFailures(deps: ProxyDeps, accountId: string): Promise<void> {
  try {
    await deps.redis.del(`${REFRESH_FAIL_COUNT_PREFIX}${accountId}`);
  } catch {
    return;
  }
}
