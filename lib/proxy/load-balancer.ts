import { prisma } from "@/lib/db";
import type { ProviderAccount } from "@prisma/client";
import { getProvidersForModel } from "./models";
import { isRateLimited, clearExpiredRateLimits } from "./rate-limit";
import { getModelFamily } from "./providers/antigravity/converter";

/**
 * Get the next active provider account for a user and model using LRU (Least Recently Used)
 * Selects the account that was used longest ago (or never used) for fair distribution
 * @param userId User ID
 * @param model Model name (used to filter accounts by provider)
 * @param provider Optional specific provider to use (if null, select across all providers that support the model)
 */
export async function getNextAccount(
  userId: string,
  model: string,
  provider: string | null = null
): Promise<ProviderAccount | null> {
  let targetProviders: string[];

  if (provider !== null) {
    // Specific provider requested
    targetProviders = [provider];
  } else {
    // Auto mode - get all providers that support this model
    targetProviders = getProvidersForModel(model);

    if (targetProviders.length === 0) {
      return null;
    }
  }

  // Get the least recently used active account (nulls first = never used accounts get priority)
  const selectedAccount = await prisma.providerAccount.findFirst({
    where: {
      userId,
      provider: { in: targetProviders },
      isActive: true,
    },
    orderBy: [
      { lastUsedAt: { sort: "asc", nulls: "first" } },
      { createdAt: "asc" }, // Tiebreaker: older accounts first
    ],
  });

  if (!selectedAccount) {
    return null;
  }

  // Update last used timestamp
  await prisma.providerAccount.update({
    where: { id: selectedAccount.id },
    data: {
      lastUsedAt: new Date(),
      requestCount: { increment: 1 },
    },
  });

  return selectedAccount;
}

/**
 * Get the next available (non-rate-limited) account for a user and model using LRU
 * Skips accounts that are rate-limited for the model's family
 * Skips accounts with "failed" status, deprioritizes "degraded" accounts
 * @param userId User ID
 * @param model Model name
 * @param provider Optional specific provider
 * @param excludeAccountIds Account IDs to exclude (already tried this request)
 */
export async function getNextAvailableAccount(
  userId: string,
  model: string,
  provider: string | null = null,
  excludeAccountIds: string[] = []
): Promise<ProviderAccount | null> {
  let targetProviders: string[];

  if (provider !== null) {
    targetProviders = [provider];
  } else {
    targetProviders = getProvidersForModel(model);
    if (targetProviders.length === 0) {
      return null;
    }
  }

  // Get all active accounts, excluding failed status
  // Ordered by: status (active before degraded), then LRU
  const accounts = await prisma.providerAccount.findMany({
    where: {
      userId,
      provider: { in: targetProviders },
      isActive: true,
      status: { not: "failed" }, // Skip failed accounts
      id: { notIn: excludeAccountIds.length > 0 ? excludeAccountIds : undefined },
    },
    orderBy: [
      { status: "asc" }, // "active" comes before "degraded" alphabetically
      { lastUsedAt: { sort: "asc", nulls: "first" } },
      { createdAt: "asc" }, // Tiebreaker: older accounts first
    ],
  });

  if (accounts.length === 0) {
    return null;
  }

  const family = getModelFamily(model);

  // Separate paid and free accounts (both already sorted by status then LRU)
  const paidAccounts = accounts.filter((a) => a.tier === "paid");
  const freeAccounts = accounts.filter((a) => a.tier !== "paid");

  // Prioritize paid accounts first, then free accounts
  let selectedAccount: ProviderAccount | null = null;
  for (const acc of [...paidAccounts, ...freeAccounts]) {
    clearExpiredRateLimits(acc.id);
    if (!isRateLimited(acc.id, family)) {
      selectedAccount = acc;
      break;
    }
  }

  if (!selectedAccount) {
    return null;
  }

  // Update last used timestamp
  await prisma.providerAccount.update({
    where: { id: selectedAccount.id },
    data: {
      lastUsedAt: new Date(),
      requestCount: { increment: 1 },
    },
  });

  return selectedAccount;
}

/**
 * Get the next active account for a specific provider using LRU
 * @param userId User ID
 * @param provider Provider name
 */
export async function getNextAccountForProvider(
  userId: string,
  provider: string
): Promise<ProviderAccount | null> {
  // Get the least recently used active account for this provider
  const selectedAccount = await prisma.providerAccount.findFirst({
    where: {
      userId,
      provider,
      isActive: true,
    },
    orderBy: [
      { lastUsedAt: { sort: "asc", nulls: "first" } },
      { createdAt: "asc" }, // Tiebreaker: older accounts first
    ],
  });

  if (!selectedAccount) {
    return null;
  }

  // Update last used timestamp
  await prisma.providerAccount.update({
    where: { id: selectedAccount.id },
    data: {
      lastUsedAt: new Date(),
      requestCount: { increment: 1 },
    },
  });

  return selectedAccount;
}

/**
 * Mark an account as having failed with error details
 * Auto-degrades status based on consecutive error count:
 * - 5+ consecutive errors: "degraded" (deprioritized in selection)
 * - 10+ consecutive errors: "failed" (skipped from rotation)
 */
export async function markAccountFailed(
  accountId: string,
  errorCode: number,
  errorMessage: string
): Promise<void> {
  // Update error tracking fields
  const account = await prisma.providerAccount.update({
    where: { id: accountId },
    data: {
      errorCount: { increment: 1 },
      consecutiveErrors: { increment: 1 },
      lastErrorAt: new Date(),
      lastErrorMessage: errorMessage.slice(0, 2000), // Limit message size
      lastErrorCode: errorCode,
    },
  });

  // Auto-degradation based on consecutive errors
  const newConsecutiveErrors = account.consecutiveErrors;
  let newStatus: string | null = null;
  let statusReason: string | null = null;

  if (newConsecutiveErrors >= 10 && account.status !== "failed") {
    newStatus = "failed";
    statusReason = `${newConsecutiveErrors} consecutive errors (auto-disabled)`;
  } else if (newConsecutiveErrors >= 5 && account.status === "active") {
    newStatus = "degraded";
    statusReason = `${newConsecutiveErrors} consecutive errors`;
  }

  if (newStatus) {
    await prisma.providerAccount.update({
      where: { id: accountId },
      data: {
        status: newStatus,
        statusReason,
        statusChangedAt: new Date(),
      },
    });
    console.log(
      `[load-balancer] Account ${accountId} status changed to ${newStatus}: ${statusReason}`
    );
  }
}

/**
 * Mark an account as having succeeded
 * Resets consecutive errors and restores status to "active" if it was degraded/failed
 */
export async function markAccountSuccess(accountId: string): Promise<void> {
  const account = await prisma.providerAccount.findUnique({
    where: { id: accountId },
    select: { status: true, consecutiveErrors: true },
  });

  if (!account) return;

  const updates: Record<string, unknown> = {
    consecutiveErrors: 0,
    successCount: { increment: 1 },
    lastSuccessAt: new Date(),
  };

  // Restore status if it was auto-degraded (not manually disabled)
  if (account.status === "degraded" || account.status === "failed") {
    updates.status = "active";
    updates.statusReason = null;
    updates.statusChangedAt = new Date();
    console.log(
      `[load-balancer] Account ${accountId} restored to active after successful request`
    );
  }

  await prisma.providerAccount.update({
    where: { id: accountId },
    data: updates,
  });
}

/**
 * Get account stats for a user
 */
export async function getAccountStats(userId: string): Promise<{
  totalAccounts: number;
  activeAccounts: number;
  totalRequests: number;
  byProvider: Record<
    string,
    { total: number; active: number; requests: number }
  >;
}> {
  const accounts = await prisma.providerAccount.findMany({
    where: { userId },
    select: {
      provider: true,
      isActive: true,
      requestCount: true,
    },
  });

  const byProvider: Record<
    string,
    { total: number; active: number; requests: number }
  > = {};

  for (const account of accounts) {
    if (!byProvider[account.provider]) {
      byProvider[account.provider] = { total: 0, active: 0, requests: 0 };
    }
    byProvider[account.provider].total++;
    if (account.isActive) {
      byProvider[account.provider].active++;
    }
    byProvider[account.provider].requests += account.requestCount;
  }

  return {
    totalAccounts: accounts.length,
    activeAccounts: accounts.filter((a) => a.isActive).length,
    totalRequests: accounts.reduce((sum, a) => sum + a.requestCount, 0),
    byProvider,
  };
}

/**
 * Get all accounts for a user grouped by provider
 */
export async function getAccountsByProvider(
  userId: string
): Promise<Record<string, ProviderAccount[]>> {
  const accounts = await prisma.providerAccount.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
  });

  const grouped: Record<string, ProviderAccount[]> = {};

  for (const account of accounts) {
    if (!grouped[account.provider]) {
      grouped[account.provider] = [];
    }
    grouped[account.provider].push(account);
  }

  return grouped;
}
