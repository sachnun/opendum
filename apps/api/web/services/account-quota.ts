import { and, eq, inArray } from "drizzle-orm";
import { db, providerAccount } from "@opendum/database";
import type { AccountQuotaBatchInput, AccountQuotaInput } from "@opendum/providers/contract";
import { type QuotaProviderKey } from "@opendum/providers/provider-accounts";
import { getProxyContext } from "../../context.js";
import { fetchAccountQuota } from "../../core/quota.js";

const quotaInFlight = new Map<string, Promise<AccountQuotaResult>>();

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
type AccountQuotaFetchOptions = { forceRefresh?: boolean };

const quotaOwnershipColumns = {
  id: providerAccount.id,
};

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" ? (value as JsonRecord) : null;
}

function isQuotaGroup(value: unknown): value is QuotaGroupDisplay {
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

function isAccountQuotaInfo(value: unknown): value is AccountQuotaInfo {
  const record = asRecord(value);
  return Boolean(
    record &&
    (record.status === "success" || record.status === "error" || record.status === "expired") &&
    Array.isArray(record.groups) &&
    record.groups.every(isQuotaGroup)
  );
}

function toPublicQuotaInfo(quota: AccountQuotaInfo): AccountQuotaInfo {
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

async function fetchQuotaFromCore(userId: string, provider: QuotaProviderKey, accountId: string, options: AccountQuotaFetchOptions = {}): Promise<AccountQuotaResult> {
  try {
    const context = await getProxyContext();
    const outcome = await fetchAccountQuota(context, { userId, provider, accountId, forceRefresh: options.forceRefresh === true });

    if (outcome.status === "unsupported") {
      return { success: false, error: `provider ${outcome.provider} is not supported for quota` };
    }
    if (outcome.status === "not-found") {
      return { success: false, error: "Account not found" };
    }
    if (outcome.status === "error") {
      return { success: false, error: outcome.message };
    }
    if (!isAccountQuotaInfo(outcome.data)) {
      return { success: false, error: "Quota provider returned an invalid response" };
    }
    return { success: true, data: toPublicQuotaInfo(outcome.data) };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Failed to fetch quota data" };
  }
}

async function fetchQuota(userId: string, provider: QuotaProviderKey, accountId: string, options: AccountQuotaFetchOptions = {}): Promise<AccountQuotaResult> {
  const inFlightKey = `${userId}:${provider}:${accountId}:${options.forceRefresh ? "force" : "cache"}`;
  const existing = quotaInFlight.get(inFlightKey);
  if (existing) return existing;

  const promise = fetchQuotaFromCore(userId, provider, accountId, options);
  quotaInFlight.set(inFlightKey, promise);
  try {
    return await promise;
  } finally {
    if (quotaInFlight.get(inFlightKey) === promise) quotaInFlight.delete(inFlightKey);
  }
}

export async function getAccountQuota(userId: string, input: AccountQuotaInput) {
  try {
    const [account] = await db
      .select(quotaOwnershipColumns)
      .from(providerAccount)
      .where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, input.provider), eq(providerAccount.id, input.accountId)))
      .limit(1);

    if (!account) return { success: false, error: "Account not found" } as const;
    const result = await fetchQuota(userId, input.provider, account.id, { forceRefresh: input.forceRefresh });
    return result;
  } catch (error) {
    console.error("Failed to fetch provider quota:", error);
    return { success: false, error: error instanceof Error ? error.message : "Failed to fetch quota data" } as const;
  }
}

export async function getAccountQuotas(userId: string, input: AccountQuotaBatchInput) {
  try {
    const accountIds = [...new Set(input.accountIds)];
    const accounts = await db
      .select(quotaOwnershipColumns)
      .from(providerAccount)
      .where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, input.provider), inArray(providerAccount.id, accountIds)));

    const accountById = new Map(accounts.map((account) => [account.id, account]));
    const results: Record<string, AccountQuotaResult> = {};
    const accountsToFetch: string[] = [];

    for (const accountId of accountIds) {
      const account = accountById.get(accountId);
      if (account) accountsToFetch.push(account.id);
      else results[accountId] = { success: false, error: "Account not found" };
    }

    await Promise.all(accountsToFetch.map(async (accountId) => {
      results[accountId] = await fetchQuota(userId, input.provider, accountId, { forceRefresh: input.forceRefresh });
    }));
    return { success: true, data: results } as const;
  } catch (error) {
    console.error("Failed to fetch provider quotas:", error);
    return { success: false, error: error instanceof Error ? error.message : "Failed to fetch quota data" } as const;
  }
}
