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

  // Get all active accounts ordered by LRU (nulls first = never used accounts get priority)
  const accounts = await prisma.providerAccount.findMany({
    where: {
      userId,
      provider: { in: targetProviders },
      isActive: true,
      id: { notIn: excludeAccountIds.length > 0 ? excludeAccountIds : undefined },
    },
    orderBy: [
      { lastUsedAt: { sort: "asc", nulls: "first" } },
      { createdAt: "asc" }, // Tiebreaker: older accounts first
    ],
  });

  if (accounts.length === 0) {
    return null;
  }

  const family = getModelFamily(model);

  // Find the first non-rate-limited account (already sorted by LRU)
  let selectedAccount: ProviderAccount | null = null;
  for (const acc of accounts) {
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
 * Mark an account as having failed (optional: for future failover logic)
 */
export async function markAccountFailed(accountId: string): Promise<void> {
  // For now, do nothing. Future: implement cooldown or deactivation
  void accountId;
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
