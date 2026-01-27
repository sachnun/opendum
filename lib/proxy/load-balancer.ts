import { prisma } from "@/lib/db";
import type { ProviderAccount } from "@prisma/client";
import { getProvidersForModel } from "./models";

// Track last used index per user + model combination for round-robin
const lastUsedIndex: Map<string, number> = new Map();

/**
 * Get the next active provider account for a user and model using round-robin
 * @param userId User ID
 * @param model Model name (used to filter accounts by provider)
 */
export async function getNextAccount(
  userId: string,
  model: string
): Promise<ProviderAccount | null> {
  // Get providers that support this model
  const supportedProviders = getProvidersForModel(model);

  if (supportedProviders.length === 0) {
    console.log(`No providers support model: ${model}`);
    return null;
  }

  // Get all active accounts for the user that support this model's provider(s)
  const accounts = await prisma.providerAccount.findMany({
    where: {
      userId,
      provider: { in: supportedProviders },
      isActive: true,
    },
    orderBy: {
      createdAt: "asc",
    },
  });

  if (accounts.length === 0) {
    console.log(
      `No active accounts for user ${userId} with providers: ${supportedProviders.join(", ")}`
    );
    return null;
  }

  // Get last used index for this user + model combination
  const key = `${userId}:${model}`;
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

  console.log(
    `Selected account ${selectedAccount.id} (${selectedAccount.provider}) for model ${model}`
  );

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
  // For now, just log. Future: implement cooldown or deactivation
  console.error(`Account ${accountId} failed a request`);
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
