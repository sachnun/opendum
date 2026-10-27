import { Effect, Result } from "effect";
import { fetchQuota as providerQuota, isQuota, type QuotaContext, type QuotaJournal } from "@opendum/providers/quota";
import { decrypt } from "@opendum/core/crypto";
import type { ProxyContext } from "@opendum/api/core/context";

export type AccountQuotaOutcome =
  | { status: "success"; data: unknown }
  | { status: "unsupported"; provider: string }
  | { status: "not-found" }
  | { status: "error"; message: string };

function redisJournal(context: ProxyContext): QuotaJournal {
  return {
    get: (key) => context.redis.get(key),
    async set(key, value, ttlSeconds) {
      await context.redis.set(key, value, { EX: ttlSeconds });
    },
  };
}

function quotaContext(context: ProxyContext): QuotaContext {
  return {
    fetch: (url, init) => context.guardedFetch(url, init),
    journal: redisJournal(context),
    decrypt: (value) => decrypt(context.config.betterAuthSecret, value),
    getCredentials: (account) => context.service.quotaCredentials(account),
  };
}

export async function fetchQuota(
  context: ProxyContext,
  input: { userId: string; provider: string; accountId: string; forceRefresh: boolean }
): Promise<AccountQuotaOutcome> {
  if (!isQuota(input.provider)) return { status: "unsupported", provider: input.provider };

  const row = await Effect.runPromise(
    context.service
      .quotaAccount(input.accountId, input.userId, input.provider)
      .pipe(Effect.catch(() => Effect.succeed(null)))
  );
  if (!row) return { status: "not-found" };

  {
    const outcome = await Effect.runPromise(
      Effect.result(providerQuota(
        quotaContext(context),
        {
          id: row.id,
          userId: row.userId,
          provider: row.provider,
          projectId: row.projectId,
          accountId: row.accountId,
          tier: row.tier,
          accessToken: row.accessToken,
        },
        input.forceRefresh
      ))
    );
    if (Result.isFailure(outcome)) {
      const cause: unknown = outcome.failure;
      return { status: "error", message: cause instanceof Error ? cause.message : String(cause) };
    }
    return { status: "success", data: outcome.success };
  }
}
