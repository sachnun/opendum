import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { db } from "../lib/db";
import { providerAccount } from "../lib/db/schema";
import { fetchInternalQuota, InternalRelayNotConfiguredError } from "../lib/proxy/internal-relay";
import { createServiceTimer } from "../utils/timing";

const MAX_SIMULTANEOUS_QUOTA_FETCHES = 3;
const MAX_QUOTA_BATCH_ACCOUNTS = 3;
const quotaProviderSchema = z.enum(["antigravity", "copilot", "codex", "gemini_cli", "kiro", "openrouter"]);
const quotaInFlight = new Map<string, Promise<AccountQuotaResult>>();

export const accountQuotaInputSchema = z.object({ provider: quotaProviderSchema, accountId: z.string() });
export const accountQuotaBatchInputSchema = z.object({ provider: quotaProviderSchema, accountIds: z.array(z.string()).min(1).max(MAX_QUOTA_BATCH_ACCOUNTS) });

type QuotaProviderKey = z.infer<typeof quotaProviderSchema>;
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
  tier: string;
  status: "success" | "error" | "expired";
  error?: string;
  groups: QuotaGroupDisplay[];
}

type AccountQuotaResult = { success: true; data: AccountQuotaInfo } | { success: false; error: string };

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
    typeof record.tier === "string" &&
    (record.status === "success" || record.status === "error" || record.status === "expired") &&
    Array.isArray(record.groups) &&
    record.groups.every(isQuotaGroup)
  );
}

function toPublicQuotaInfo(quota: AccountQuotaInfo): AccountQuotaInfo {
  return {
    tier: quota.tier,
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

async function persistDetectedTier(accountId: string, quota: AccountQuotaInfo) {
  const tier = quota.tier.trim();
  if (!tier || tier.toLowerCase() === "unknown") return;
  await db.update(providerAccount).set({ tier }).where(eq(providerAccount.id, accountId));
}

async function fetchQuotaFromProxy(userId: string, provider: QuotaProviderKey, accountId: string): Promise<AccountQuotaResult> {
  try {
    const response = await fetchInternalQuota({ userId, provider, accountId });
    const payload = asRecord(await response.json().catch(() => null));

    if (!response.ok) {
      return { success: false, error: typeof payload?.error === "string" ? payload.error : `Quota proxy failed: HTTP ${response.status}` };
    }
    if (payload?.success === true && isAccountQuotaInfo(payload.data)) {
      return { success: true, data: toPublicQuotaInfo(payload.data) };
    }
    if (payload?.success === false && typeof payload.error === "string") {
      return { success: false, error: payload.error };
    }
    return { success: false, error: "Quota proxy returned an invalid response" };
  } catch (error) {
    if (error instanceof InternalRelayNotConfiguredError) return { success: false, error: "Proxy URL is required to fetch quota. Set NUXT_PUBLIC_PROXY_URL to your proxy URL." };
    return { success: false, error: error instanceof Error ? error.message : "Failed to fetch quota data" };
  }
}

async function fetchAccountQuota(userId: string, provider: QuotaProviderKey, accountId: string): Promise<AccountQuotaResult> {
  const inFlightKey = `${userId}:${provider}:${accountId}`;
  const existing = quotaInFlight.get(inFlightKey);
  if (existing) return existing;

  const promise = fetchQuotaFromProxy(userId, provider, accountId);
  quotaInFlight.set(inFlightKey, promise);
  try {
    return await promise;
  } finally {
    if (quotaInFlight.get(inFlightKey) === promise) quotaInFlight.delete(inFlightKey);
  }
}

export async function getAccountQuota(userId: string, input: z.infer<typeof accountQuotaInputSchema>) {
  const timer = createServiceTimer("accounts.quota", { provider: input.provider });
  try {
    const [account] = await timer.time("ownership", () => db
      .select(quotaOwnershipColumns)
      .from(providerAccount)
      .where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, input.provider), eq(providerAccount.id, input.accountId)))
      .limit(1));

    if (!account) return { success: false, error: "Account not found" } as const;
    const result = await timer.time("fetchQuota", () => fetchAccountQuota(userId, input.provider, account.id));
    if (result.success) await timer.time("persistTier", () => persistDetectedTier(account.id, result.data));
    timer.log({ accounts: 1, success: result.success });
    return result;
  } catch (error) {
    console.error("Failed to fetch provider quota:", error);
    return { success: false, error: error instanceof Error ? error.message : "Failed to fetch quota data" } as const;
  }
}

export async function getAccountQuotas(userId: string, input: z.infer<typeof accountQuotaBatchInputSchema>) {
  const timer = createServiceTimer("accounts.quotas", { provider: input.provider });
  try {
    const accountIds = [...new Set(input.accountIds)];
    const accounts = await timer.time("ownership", () => db
      .select(quotaOwnershipColumns)
      .from(providerAccount)
      .where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, input.provider), inArray(providerAccount.id, accountIds))));

    const accountById = new Map(accounts.map((account) => [account.id, account]));
    const results: Record<string, AccountQuotaResult> = {};
    const accountsToFetch: string[] = [];

    for (const accountId of accountIds) {
      const account = accountById.get(accountId);
      if (account) accountsToFetch.push(account.id);
      else results[accountId] = { success: false, error: "Account not found" };
    }

    let nextAccountIndex = 0;
    const workerCount = Math.min(MAX_SIMULTANEOUS_QUOTA_FETCHES, accountsToFetch.length);
    const runWorker = async () => {
      while (true) {
        const accountId = accountsToFetch[nextAccountIndex];
        nextAccountIndex += 1;
        if (!accountId) return;
        results[accountId] = await fetchAccountQuota(userId, input.provider, accountId);
        const result = results[accountId];
        if (result?.success) await persistDetectedTier(accountId, result.data);
      }
    };

    await timer.time("fetchQuotas", () => Promise.all(Array.from({ length: workerCount }, () => runWorker())));
    timer.log({ requestedAccounts: accountIds.length, fetchedAccounts: accountsToFetch.length, workerCount });
    return { success: true, data: results } as const;
  } catch (error) {
    console.error("Failed to fetch provider quotas:", error);
    return { success: false, error: error instanceof Error ? error.message : "Failed to fetch quota data" } as const;
  }
}
