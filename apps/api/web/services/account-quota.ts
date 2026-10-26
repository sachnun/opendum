import { Effect } from "effect";
import { and, eq, inArray } from "drizzle-orm";
import { db, providerAccount } from "@opendum/database";
import type { QuotaBatchInput, AccountQuotaInput } from "@opendum/providers/contract";
import { type QuotaProviderKey } from "@opendum/providers/provider-accounts";
import { proxyContext } from "../../context.js";
import { fetchQuota as coreQuota } from "../../core/quota.js";
import { fromPromise } from "#web/lib/task.js";
import { internal } from "#web/errors.js";

const quotaInFlight = new Map<string, Effect.Effect<AccountQuotaResult>>();

type JsonRecord = Record<string, unknown>;

interface QuotaGroupDisplay {
  name: string;
  displayName: string;
  remainingFraction: number;
  remainingRequests: number;
  maxRequests: number;
  usedRequests: number;
  resetTimeIso: string | null;
  resetInHuman: string | null;
}

interface AccountQuotaInfo {
  status: "success" | "error" | "expired";
  error?: string;
  groups: QuotaGroupDisplay[];
}

type AccountQuotaResult = { success: true; data: AccountQuotaInfo } | { success: false; error: string };
type QuotaOptions = { forceRefresh?: boolean };

const quotaOwnershipColumns = {
  id: providerAccount.id,
};

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" ? (value as JsonRecord) : null;
}

function isGroup(value: unknown): value is QuotaGroupDisplay {
  const record = asRecord(value);
  return Boolean(
    record &&
    typeof record.name === "string" &&
    typeof record.displayName === "string" &&
    typeof record.remainingFraction === "number" &&
    typeof record.remainingRequests === "number" &&
    typeof record.maxRequests === "number" &&
    typeof record.usedRequests === "number" &&
    (record.resetTimeIso === null || typeof record.resetTimeIso === "string") &&
    (record.resetInHuman === null || typeof record.resetInHuman === "string")
  );
}

function isInfo(value: unknown): value is AccountQuotaInfo {
  const record = asRecord(value);
  return Boolean(
    record &&
    (record.status === "success" || record.status === "error" || record.status === "expired") &&
    Array.isArray(record.groups) &&
    record.groups.every(isGroup)
  );
}

function toPublic(quota: AccountQuotaInfo): AccountQuotaInfo {
  return {
    status: quota.status,
    ...(quota.error ? { error: quota.error } : {}),
    groups: quota.groups.map((group) => ({
      name: group.name,
      displayName: group.displayName,
      remainingFraction: group.remainingFraction,
      remainingRequests: group.remainingRequests,
      maxRequests: group.maxRequests,
      usedRequests: group.usedRequests,
      resetTimeIso: group.resetTimeIso,
      resetInHuman: group.resetInHuman,
    })),
  };
}

const quotaFromCore = Effect.fn("accountQuota.fetchFromCore")(function* (
  userId: string,
  provider: QuotaProviderKey,
  accountId: string,
  options: QuotaOptions = {}
) {
  const context = yield* fromPromise(() => proxyContext(), "Failed to start the proxy runtime").pipe(
    Effect.catch(() => Effect.succeed(null))
  );
  if (!context) return { success: false as const, error: "Failed to fetch quota data" };

  const outcome = yield* fromPromise(
    () =>
      coreQuota(context, {
        userId,
        provider,
        accountId,
        forceRefresh: options.forceRefresh === true,
      }),
    "Failed to fetch quota data"
  ).pipe(Effect.catch((failure) => Effect.succeed({ status: "error" as const, message: failure.message })));

  if (outcome.status === "unsupported") {
    return { success: false as const, error: `provider ${outcome.provider} is not supported for quota` };
  }
  if (outcome.status === "not-found") {
    return { success: false as const, error: "Account not found" };
  }
  if (outcome.status === "error") {
    return { success: false as const, error: outcome.message };
  }
  if (!isInfo(outcome.data)) {
    return { success: false as const, error: "Quota provider returned an invalid response" };
  }
  return { success: true as const, data: toPublic(outcome.data) };
});

const quotaFor = Effect.fn("accountQuota.fetch")(function* (
  userId: string,
  provider: QuotaProviderKey,
  accountId: string,
  options: QuotaOptions = {}
) {
  const inFlightKey = `${userId}:${provider}:${accountId}:${options.forceRefresh ? "force" : "cache"}`;
  const existing = quotaInFlight.get(inFlightKey);
  if (existing) return yield* existing;

  const pending = Effect.cached(quotaFromCore(userId, provider, accountId, options)).pipe(
    Effect.flatten
  );
  quotaInFlight.set(inFlightKey, pending);
  return yield* pending.pipe(
    Effect.ensuring(
      Effect.sync(() => {
        if (quotaInFlight.get(inFlightKey) === pending) quotaInFlight.delete(inFlightKey);
      })
    )
  );
});

export const getAccountQuota = Effect.fn("accountQuota.get")(function* (
  userId: string,
  input: AccountQuotaInput
) {
  const accounts = yield* fromPromise(
    () =>
      db
        .select(quotaOwnershipColumns)
        .from(providerAccount)
        .where(
          and(
            eq(providerAccount.userId, userId),
            eq(providerAccount.provider, input.provider),
            eq(providerAccount.id, input.accountId)
          )
        )
        .limit(1),
    "Failed to fetch provider quota"
  ).pipe(Effect.catch(() => Effect.succeed([])));

  const account = accounts[0];
  if (!account) return { success: false as const, error: "Account not found" };
  return yield* quotaFor(userId, input.provider, account.id, {
    forceRefresh: input.forceRefresh,
  });
});

export const getAccountQuotas = Effect.fn("accountQuota.list")(function* (
  userId: string,
  input: QuotaBatchInput
) {
  return yield* quotasInner(userId, input).pipe(
    Effect.catch((failure: { message: string }) =>
      Effect.succeed({ success: false as const, error: failure.message })
    )
  );
});

const quotasInner = Effect.fnUntraced(function* (
  userId: string,
  input: QuotaBatchInput
) {
  const accountIds = [...new Set(input.accountIds)];
  const accounts = yield* fromPromise(
    () =>
      db
        .select(quotaOwnershipColumns)
        .from(providerAccount)
        .where(
          and(
            eq(providerAccount.userId, userId),
            eq(providerAccount.provider, input.provider),
            inArray(providerAccount.id, accountIds)
          )
        ),
    "Failed to fetch provider quotas"
  ).pipe(
    Effect.mapError((failure) => internal("Failed to fetch provider quotas", failure.cause ?? failure))
  );

  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const results: Record<string, AccountQuotaResult> = {};
  const accountsToFetch: string[] = [];

  for (const accountId of accountIds) {
    const account = accountById.get(accountId);
    if (account) accountsToFetch.push(account.id);
    else results[accountId] = { success: false, error: "Account not found" };
  }

  const fetched = yield* Effect.forEach(
    accountsToFetch,
    (accountId) =>
      quotaFor(userId, input.provider, accountId, { forceRefresh: input.forceRefresh }).pipe(
        Effect.map((result) => [accountId, result] as const)
      ),
    { concurrency: 4 }
  );
  for (const [accountId, result] of fetched) results[accountId] = result;

  return { success: true as const, data: results };
});
