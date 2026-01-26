import { prisma } from "@/lib/db";
import type { IflowAccount } from ".prisma/client";

// Track last used index per user for round-robin
const lastUsedIndex: Map<string, number> = new Map();

/**
 * Get the next active iFlow account for a user using round-robin
 */
export async function getNextAccount(userId: string): Promise<IflowAccount | null> {
  // Get all active accounts for the user
  const accounts = await prisma.iflowAccount.findMany({
    where: {
      userId,
      isActive: true,
    },
    orderBy: {
      createdAt: "asc",
    },
  });

  if (accounts.length === 0) {
    return null;
  }

  // Get last used index for this user
  const lastIndex = lastUsedIndex.get(userId) ?? -1;
  
  // Calculate next index (round-robin)
  const nextIndex = (lastIndex + 1) % accounts.length;
  
  // Update last used index
  lastUsedIndex.set(userId, nextIndex);
  
  const selectedAccount = accounts[nextIndex];
  
  // Update last used timestamp
  await prisma.iflowAccount.update({
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
}> {
  const accounts = await prisma.iflowAccount.findMany({
    where: { userId },
    select: {
      isActive: true,
      requestCount: true,
    },
  });

  return {
    totalAccounts: accounts.length,
    activeAccounts: accounts.filter((a) => a.isActive).length,
    totalRequests: accounts.reduce((sum, a) => sum + a.requestCount, 0),
  };
}
