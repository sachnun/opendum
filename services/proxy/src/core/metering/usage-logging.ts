import { randomUUID } from "node:crypto";

import type { AuthResult, ModelValidationResult } from "@opendum/auth";
import { insertUsageLog } from "@opendum/database/queries";
import type { ProviderAccount } from "@opendum/providers";

import { HYPERCREDITS_BALANCE_PREFIX, HYPERCREDITS_BALANCE_TTL_SECONDS } from "../service-constants.ts";
import type { ProxyDeps } from "../service-deps.ts";
import { isSyntheticProviderAccountId } from "../transport/service-helpers.ts";
import { markAccountFailed, markAccountSuccess } from "../health/service-health.ts";

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
