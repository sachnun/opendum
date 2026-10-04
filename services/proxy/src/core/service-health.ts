import { randomUUID } from "node:crypto";

import type { AuthResult, ModelValidationResult } from "@opendum/auth";
import {
  bumpAccountRequestCount,
  getAccountHealthState,
  getAccountOwnerUserID,
  getModelHealth,
  insertModelHealth,
  insertUsageLog,
  listModelHealthByAccount,
  markAccountRecoveredByRotation,
  markAccountSuccess as markAccountSuccessQuery,
  markUsageLimitedHealth,
  recordRequestError,
  setAccountActive,
  setAccountCooldown,
  setAccountHealthFailed,
  setAccountUsageLimited,
  updateModelHealthCounters,
  updateModelHealthFailure,
  updateModelHealthFailureWithStatus,
  updateModelHealthStatus,
  updateModelHealthSuccess,
  updateModelHealthSuccessWithStatus,
} from "@opendum/database/queries";
import type { ProviderAccount } from "@opendum/providers";

import { upsertErrorHistory } from "./error-history.js";
import {
  ACCOUNT_COOLDOWN_UNHEALTHY_THRESHOLD,
  FAILED_COOLDOWN_MS,
  HYPERCREDITS_BALANCE_PREFIX,
  HYPERCREDITS_BALANCE_TTL_SECONDS,
  MAX_STORED_ERROR_LEN,
} from "./service-constants.js";
import type { ProxyDeps } from "./service-deps.js";
import {
  cooldownRecoveryCount,
  effectiveUnhealthyCount,
  isSyntheticProviderAccountId,
  modelHealthStatus,
  successRecoveryCount,
} from "./service-helpers.js";
import type { AccountRotationFailure } from "./types.js";

export async function markAccountSuccess(deps: ProxyDeps, accountId: string, model: string): Promise<void> {
  if (isSyntheticProviderAccountId(accountId)) return;
  const now = new Date();
  await markAccountSuccessQuery({ id: accountId, at: now }, deps.database);
  const resolved = deps.models.resolveAlias(model);
  const health = await getModelHealth(accountId, resolved, deps.database);
  if (!health) {
    await refreshAccountHealthFromModels(deps, accountId, now);
    return;
  }
  const nextErrors = successRecoveryCount(health, now);
  const nextStatus = modelHealthStatus(nextErrors);
  if (nextStatus !== health.status) {
    await updateModelHealthSuccessWithStatus(
      {
        id: health.id,
        consecutiveErrors: nextErrors,
        lastSuccessAt: now,
        unhealthyCountUpdatedAt: now,
        status: nextStatus,
        statusChangedAt: now,
      },
      deps.database
    );
  } else {
    await updateModelHealthSuccess(
      { id: health.id, consecutiveErrors: nextErrors, lastSuccessAt: now, unhealthyCountUpdatedAt: now },
      deps.database
    );
  }
  await refreshAccountHealthFromModels(deps, accountId, now);
}

export async function markAccountFailed(
  deps: ProxyDeps,
  accountId: string,
  model: string,
  statusCode: number,
  message: string
): Promise<Date> {
  const now = new Date();
  if (isSyntheticProviderAccountId(accountId)) return now;
  const stored = message.length > MAX_STORED_ERROR_LEN ? message.slice(0, MAX_STORED_ERROR_LEN) : message;
  await recordRequestError({ id: accountId, at: now, code: statusCode }, deps.database);
  const resolved = deps.models.resolveAlias(model);
  const health = await getModelHealth(accountId, resolved, deps.database);
  if (health) {
    const nextErrors = effectiveUnhealthyCount(health, now) + 1;
    const nextStatus = modelHealthStatus(nextErrors);
    if (nextStatus !== health.status) {
      await updateModelHealthFailureWithStatus(
        {
          id: health.id,
          consecutiveErrors: nextErrors,
          lastErrorAt: now,
          lastErrorCode: statusCode,
          unhealthyCountUpdatedAt: now,
          status: nextStatus,
          statusChangedAt: now,
        },
        deps.database
      );
    } else {
      await updateModelHealthFailure(
        {
          id: health.id,
          consecutiveErrors: nextErrors,
          lastErrorAt: now,
          lastErrorCode: statusCode,
          unhealthyCountUpdatedAt: now,
        },
        deps.database
      );
    }
  } else {
    const nextErrors = 1;
    await insertModelHealth(
      {
        id: randomUUID(),
        providerAccountId: accountId,
        model: resolved,
        consecutiveErrors: nextErrors,
        status: modelHealthStatus(nextErrors),
        lastErrorAt: now,
        lastErrorCode: statusCode,
        unhealthyCountUpdatedAt: now,
        createdAt: now,
        updatedAt: now,
      },
      deps.database
    );
  }
  await refreshAccountHealthFromModels(deps, accountId, now);
  const ownerUserId = await getAccountOwnerUserID(accountId, deps.database);
  if (ownerUserId) {
    await upsertErrorHistory(deps.redis, accountId, ownerUserId, resolved, statusCode, stored, now);
  }
  return now;
}

export async function markAccountUsageLimited(
  deps: ProxyDeps,
  accountId: string,
  model: string,
  disabledUntil: Date,
  failedAt: Date
): Promise<void> {
  if (isSyntheticProviderAccountId(accountId)) return;
  const resolved = deps.models.resolveAlias(model);
  await markUsageLimitedHealth(
    {
      providerAccountId: accountId,
      model: resolved,
      status: "failed",
      at: failedAt,
      consecutiveErrors: ACCOUNT_COOLDOWN_UNHEALTHY_THRESHOLD,
    },
    deps.database
  );
  await refreshAccountHealthFromModels(deps, accountId, failedAt);
  await setAccountUsageLimited({ id: accountId, disabledUntil, status: "failed", at: failedAt }, deps.database);
}

export async function markAccountsRecoveredByRotation(
  deps: ProxyDeps,
  failures: AccountRotationFailure[]
): Promise<void> {
  const latest = new Map<string, Date>();
  for (const failure of failures) {
    const existing = latest.get(failure.accountId);
    if (!existing || failure.failedAt.getTime() > existing.getTime()) latest.set(failure.accountId, failure.failedAt);
  }
  if (latest.size === 0) return;
  const recoveredAt = new Date();
  for (const [accountId, failedAt] of latest) {
    if (isSyntheticProviderAccountId(accountId)) continue;
    await markAccountRecoveredByRotation({ id: accountId, at: recoveredAt, beforeOrAt: failedAt }, deps.database);
  }
}

export async function logAccountError(
  deps: ProxyDeps,
  accountId: string,
  userId: string,
  model: string,
  statusCode: number,
  message: string
): Promise<void> {
  if (isSyntheticProviderAccountId(accountId)) return;
  const stored = message.length > MAX_STORED_ERROR_LEN ? message.slice(0, MAX_STORED_ERROR_LEN) : message;
  const resolved = deps.models.resolveAlias(model);
  await upsertErrorHistory(deps.redis, accountId, userId, resolved, statusCode, stored, new Date());
}

export async function refreshAccountHealthFromModels(
  deps: ProxyDeps,
  accountId: string,
  now: Date
): Promise<boolean> {
  if (isSyntheticProviderAccountId(accountId)) return false;
  const account = await getAccountHealthState(accountId, deps.database);
  if (!account) return false;
  const rows = await listModelHealthByAccount(accountId, deps.database);
  const applyCooldownRecovery =
    account.status === "failed" && account.disabledUntil !== null && account.disabledUntil.getTime() <= now.getTime();
  const total = await normalizeModelHealthRows(deps, rows, now, applyCooldownRecovery);

  if (account.disabledUntil && account.disabledUntil.getTime() > now.getTime()) {
    if (account.consecutiveErrors !== total) {
      await setAccountHealthFailed(
        { id: accountId, consecutiveErrors: total, status: "failed", at: now },
        deps.database
      );
    }
    return true;
  }
  if (total >= ACCOUNT_COOLDOWN_UNHEALTHY_THRESHOLD) {
    await setAccountCooldown(
      {
        id: accountId,
        status: "failed",
        at: now,
        consecutiveErrors: total,
        disabledUntil: new Date(now.getTime() + FAILED_COOLDOWN_MS),
      },
      deps.database
    );
    return true;
  }
  if (
    account.status !== "active" ||
    (account.disabledUntil !== null && account.disabledUntil.getTime() <= now.getTime()) ||
    account.consecutiveErrors !== total
  ) {
    await setAccountActive({ id: accountId, status: "active", at: now, consecutiveErrors: total }, deps.database);
  }
  return false;
}

async function normalizeModelHealthRows(
  deps: ProxyDeps,
  rows: Awaited<ReturnType<typeof listModelHealthByAccount>>,
  now: Date,
  applyCooldownRecovery: boolean
): Promise<number> {
  let total = 0;
  for (const row of rows) {
    let count = effectiveUnhealthyCount(row, now);
    if (applyCooldownRecovery) count = cooldownRecoveryCount(count);
    const status = modelHealthStatus(count);
    const statusChanged = status !== row.status;
    total += count;
    if (count === row.consecutiveErrors && !statusChanged && !applyCooldownRecovery) continue;
    if (row.status === "failed" || statusChanged) {
      await updateModelHealthStatus(
        { id: row.id, consecutiveErrors: count, unhealthyCountUpdatedAt: now, status, statusChangedAt: now },
        deps.database
      );
      continue;
    }
    await updateModelHealthCounters(
      { id: row.id, consecutiveErrors: count, unhealthyCountUpdatedAt: now },
      deps.database
    );
  }
  return total;
}

export async function bumpAccountRequestCountDeferred(deps: ProxyDeps, accountId: string): Promise<void> {
  if (isSyntheticProviderAccountId(accountId)) return;
  try {
    await bumpAccountRequestCount({ id: accountId, at: new Date() }, deps.database);
  } catch {
    return;
  }
}

export async function logUsage(
  deps: ProxyDeps,
  authResult: AuthResult,
  account: ProviderAccount,
  validation: ModelValidationResult,
  statusCode: number,
  durationMs: number
): Promise<void> {
  await logUsageRaw(deps, {
    userId: authResult.userId,
    providerAccountId: account.id,
    proxyApiKeyId: authResult.apiKeyId,
    model: validation.model,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    statusCode,
    durationMs,
  });
}

export async function logUsageRaw(
  deps: ProxyDeps,
  params: {
    userId: string;
    providerAccountId: string;
    proxyApiKeyId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    cacheWriteTokens: number;
    statusCode: number;
    durationMs: number;
  }
): Promise<void> {
  if (!params.userId || !params.model) return;
  const providerAccountId =
    params.providerAccountId && !isSyntheticProviderAccountId(params.providerAccountId)
      ? params.providerAccountId
      : null;
  try {
    await insertUsageLog(
      {
        id: randomUUID(),
        userId: params.userId,
        providerAccountId,
        proxyApiKeyId: params.proxyApiKeyId || null,
        model: params.model,
        inputTokens: params.inputTokens,
        outputTokens: params.outputTokens,
        cachedTokens: params.cachedTokens,
        cacheWriteTokens: params.cacheWriteTokens,
        statusCode: params.statusCode,
        duration: params.durationMs,
        createdAt: new Date(),
      },
      deps.database
    );
    await deps.auth.bumpAnalyticsCacheVersionThrottled(params.userId);
  } catch {
    return;
  }
}

export async function recordResponseHandlerFailure(
  deps: ProxyDeps,
  account: ProviderAccount,
  authResult: AuthResult,
  validation: ModelValidationResult,
  statusCode: number,
  message: string,
  startMs: number
): Promise<void> {
  try {
    await markAccountFailed(deps, account.id, validation.model, statusCode, message);
    await logUsage(deps, authResult, account, validation, statusCode, Date.now() - startMs);
  } catch {
    return;
  }
}

export function storeHypercreditsUsage(
  deps: ProxyDeps,
  accountId: string,
  remaining: number | null,
  cost: number
): void {
  if (!accountId) return;
  void (async () => {
    try {
      const key = HYPERCREDITS_BALANCE_PREFIX + accountId;
      if (remaining !== null && remaining > 0) {
        await deps.redis.set(key, String(remaining), { EX: HYPERCREDITS_BALANCE_TTL_SECONDS });
        return;
      }
      if (cost > 0) {
        const raw = await deps.redis.get(key);
        const current = raw === null ? Number.NaN : Number(raw);
        if (Number.isFinite(current) && current > 0) {
          const next = Math.max(0, current - cost);
          await deps.redis.set(key, String(next), { EX: HYPERCREDITS_BALANCE_TTL_SECONDS });
        }
      }
    } catch {
      return;
    }
  })();
}

export function recordSuccessfulRequest(
  deps: ProxyDeps,
  params: {
    accountId: string;
    provider: string;
    model: string;
    userId: string;
    apiKeyId: string;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    cacheWriteTokens: number;
    durationMs: number;
    stream: boolean;
    requestStartMs: number;
    upstreamFirstResponseMs: number;
  }
): void {
  void (async () => {
    try {
      await markAccountSuccess(deps, params.accountId, params.model);
      await deps.performance.record({
        provider: params.provider,
        model: deps.models.resolveAlias(params.model),
        ttftMs:
          params.upstreamFirstResponseMs > params.requestStartMs
            ? params.upstreamFirstResponseMs - params.requestStartMs
            : 0,
        outputTokens: params.outputTokens,
        durationMs: params.durationMs,
      });
      await logUsageRaw(deps, {
        userId: params.userId,
        providerAccountId: params.accountId,
        proxyApiKeyId: params.apiKeyId,
        model: params.model,
        inputTokens: params.inputTokens,
        outputTokens: params.outputTokens,
        cachedTokens: params.cachedTokens,
        cacheWriteTokens: params.cacheWriteTokens,
        statusCode: 200,
        durationMs: params.durationMs,
      });
    } catch {
      return;
    }
  })();
}
