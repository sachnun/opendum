import { prisma } from "@/lib/db";
import type { ProviderAccount } from "@prisma/client";
import { getProvidersForModel } from "./models";

// Track last used index per user + model combination for round-robin
const lastUsedIndex: Map<string, number> = new Map();

/**
 * Get the next active provider account for a user and model using round-robin
 * @param userId User ID
 * @param model Model name (used to filter accounts by provider)
 * @param provider Optional specific provider to use (if null, round-robin across all providers that support the model)
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

  // Get all active accounts for the user that match the target provider(s)
  const accounts = await prisma.providerAccount.findMany({
    where: {
      userId,
      provider: { in: targetProviders },
      isActive: true,
    },
    orderBy: {
      createdAt: "asc",
    },
  });

  if (accounts.length === 0) {
    return null;
  }

  // Get last used index for this user + model + provider combination
  const key = provider !== null 
    ? `${userId}:${provider}:${model}` 
    : `${userId}:${model}`;
  const lastIndex = lastUsedIndex.get(key) ?? -1;

  // Calculate next index (round-robin)
  const nextIndex = (lastIndex + 1) % accounts.length;

  // Update last used index
  lastUsedIndex.set(key, nextIndex);

  const selectedAccount = accounts[nextIndex];

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
 * Get the next active account for a specific provider
 * @param userId User ID
 * @param provider Provider name
 */
export async function getNextAccountForProvider(
  userId: string,
  provider: string
): Promise<ProviderAccount | null> {
  const accounts = await prisma.providerAccount.findMany({
    where: {
      userId,
      provider,
      isActive: true,
    },
    orderBy: {
      createdAt: "asc",
    },
  });

  if (accounts.length === 0) {
    return null;
  }

  // Get last used index for this user + provider combination
  const key = `${userId}:provider:${provider}`;
  const lastIndex = lastUsedIndex.get(key) ?? -1;

  // Calculate next index (round-robin)
  const nextIndex = (lastIndex + 1) % accounts.length;

  // Update last used index
  lastUsedIndex.set(key, nextIndex);

  const selectedAccount = accounts[nextIndex];

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
