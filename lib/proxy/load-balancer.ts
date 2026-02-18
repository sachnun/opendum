import { db } from "@/lib/db";
import { providerAccount } from "@/lib/db/schema";
import { eq, and, inArray, notInArray, asc, sql } from "drizzle-orm";
import type { ProviderAccount } from "@/lib/db/schema";
import { getProvidersForModel } from "./models";
import { getRateLimitedAccountIds, getRateLimitScope } from "./rate-limit";

const FAILED_ACCOUNT_RETRY_COOLDOWN_MS = 10 * 60 * 1000;
const MAX_STORED_ERROR_MESSAGE_LENGTH = 10000;

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
  const [selectedAccount] = await db
    .select()
    .from(providerAccount)
    .where(
      and(
        eq(providerAccount.userId, userId),
        inArray(providerAccount.provider, targetProviders),
        eq(providerAccount.isActive, true)
      )
    )
    .orderBy(
      sql`${providerAccount.lastUsedAt} ASC NULLS FIRST`,
      asc(providerAccount.createdAt)
    )
    .limit(1);

  if (!selectedAccount) {
    return null;
  }

  // Update last used timestamp
  await db
    .update(providerAccount)
    .set({
      lastUsedAt: new Date(),
      requestCount: sql`${providerAccount.requestCount} + 1`,
    })
    .where(eq(providerAccount.id, selectedAccount.id));

  return selectedAccount;
}

/**
 * Get the next available (non-rate-limited) account for a user and model using LRU
 * Skips accounts that are rate-limited for the requested model
 * Deprioritizes degraded and failed accounts.
 * Failed accounts are retried automatically after a cooldown window.
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

  // Get all active accounts.
  // Ordered by: status (active -> degraded -> failed), then LRU.
  const whereConditions = [
    eq(providerAccount.userId, userId),
    inArray(providerAccount.provider, targetProviders),
    eq(providerAccount.isActive, true),
  ];

  if (excludeAccountIds.length > 0) {
    whereConditions.push(notInArray(providerAccount.id, excludeAccountIds));
  }

  const accounts = await db
    .select()
    .from(providerAccount)
    .where(and(...whereConditions))
    .orderBy(
      asc(providerAccount.status),
      sql`${providerAccount.lastUsedAt} ASC NULLS FIRST`,
      asc(providerAccount.createdAt)
    );

  if (accounts.length === 0) {
    return null;
  }

  const rateLimitScope = getRateLimitScope(model);

  // Separate paid and free accounts (both already sorted by status then LRU)
  const paidAccounts = accounts.filter((a) => a.tier === "paid");
  const freeAccounts = accounts.filter((a) => a.tier !== "paid");

  // Prioritize paid accounts first, then free accounts
  let selectedAccount: ProviderAccount | null = null;
  const now = Date.now();
  const prioritizedAccounts = [...paidAccounts, ...freeAccounts];
  const rateLimitedAccountIds = await getRateLimitedAccountIds(
    prioritizedAccounts.map((account) => account.id),
    rateLimitScope
  );

  for (const acc of prioritizedAccounts) {
    if (acc.status === "failed" && acc.statusChangedAt) {
      const elapsed = now - acc.statusChangedAt.getTime();
      if (elapsed < FAILED_ACCOUNT_RETRY_COOLDOWN_MS) {
        continue;
      }
    }

    if (!rateLimitedAccountIds.has(acc.id)) {
      selectedAccount = acc;
      break;
    }
  }

  if (!selectedAccount) {
    return null;
  }

  // Update last used timestamp
  await db
    .update(providerAccount)
    .set({
      lastUsedAt: new Date(),
      requestCount: sql`${providerAccount.requestCount} + 1`,
    })
    .where(eq(providerAccount.id, selectedAccount.id));

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
  const [selectedAccount] = await db
    .select()
    .from(providerAccount)
    .where(
      and(
        eq(providerAccount.userId, userId),
        eq(providerAccount.provider, provider),
        eq(providerAccount.isActive, true)
      )
    )
    .orderBy(
      sql`${providerAccount.lastUsedAt} ASC NULLS FIRST`,
      asc(providerAccount.createdAt)
    )
    .limit(1);

  if (!selectedAccount) {
    return null;
  }

  // Update last used timestamp
  await db
    .update(providerAccount)
    .set({
      lastUsedAt: new Date(),
      requestCount: sql`${providerAccount.requestCount} + 1`,
    })
    .where(eq(providerAccount.id, selectedAccount.id));

  return selectedAccount;
}
/**
 * Mark an account as having failed with error details
 * Auto-degrades status based on consecutive error count:
 * - 5+ consecutive errors: "degraded" (deprioritized in selection)
 * - 10+ consecutive errors: "failed" (temporarily sidelined, retried after cooldown)
 */
export async function markAccountFailed(
  accountId: string,
  errorCode: number,
  errorMessage: string
): Promise<void> {
  // Update error tracking fields
  const [account] = await db
    .update(providerAccount)
    .set({
      errorCount: sql`${providerAccount.errorCount} + 1`,
      consecutiveErrors: sql`${providerAccount.consecutiveErrors} + 1`,
      lastErrorAt: new Date(),
      lastErrorMessage: errorMessage.slice(0, MAX_STORED_ERROR_MESSAGE_LENGTH),
      lastErrorCode: errorCode,
    })
    .where(eq(providerAccount.id, accountId))
    .returning();

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
    await db
      .update(providerAccount)
      .set({
        status: newStatus,
        statusReason,
        statusChangedAt: new Date(),
      })
      .where(eq(providerAccount.id, accountId));
  }
}

/**
 * Mark an account as having succeeded
 * Resets consecutive errors and restores status to "active" if it was degraded/failed
 */
export async function markAccountSuccess(accountId: string): Promise<void> {
  const [account] = await db
    .select({
      status: providerAccount.status,
      consecutiveErrors: providerAccount.consecutiveErrors,
    })
    .from(providerAccount)
    .where(eq(providerAccount.id, accountId))
    .limit(1);

  if (!account) return;

  const updates: Record<string, unknown> = {
    consecutiveErrors: 0,
    successCount: sql`${providerAccount.successCount} + 1`,
    lastSuccessAt: new Date(),
  };

  // Restore status if it was auto-degraded (not manually disabled)
  if (account.status === "degraded" || account.status === "failed") {
    updates.status = "active";
    updates.statusReason = null;
    updates.statusChangedAt = new Date();
  }

  await db
    .update(providerAccount)
    .set(updates)
    .where(eq(providerAccount.id, accountId));
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
  const accounts = await db
    .select({
      provider: providerAccount.provider,
      isActive: providerAccount.isActive,
      requestCount: providerAccount.requestCount,
    })
    .from(providerAccount)
    .where(eq(providerAccount.userId, userId));

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
  const accounts = await db
    .select()
    .from(providerAccount)
    .where(eq(providerAccount.userId, userId))
    .orderBy(asc(providerAccount.createdAt));

  const grouped: Record<string, ProviderAccount[]> = {};

  for (const account of accounts) {
    if (!grouped[account.provider]) {
      grouped[account.provider] = [];
    }
    grouped[account.provider].push(account);
  }

  return grouped;
}
