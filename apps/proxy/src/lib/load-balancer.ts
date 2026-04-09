import { db } from "@opendum/shared/db";
import { providerAccount, providerAccountErrorHistory, providerAccountModelHealth, providerAccountDisabledModel } from "@opendum/shared/db/schema";
import { eq, and, inArray, notInArray, asc, desc, sql } from "drizzle-orm";
import type { ProviderAccount } from "@opendum/shared/db/schema";
import type { ApiKeyAccountAccess } from "@opendum/shared/proxy/auth";
import { getProvidersForModel, resolveModelAlias, getModelLookupKeys } from "@opendum/shared/proxy/models";
import { getRateLimitedAccountIds, getRateLimitScope } from "./rate-limit.js";

const FAILED_COOLDOWN_MS = 10 * 60 * 1000;
const DEGRADED_THRESHOLD = 3;
const FAILED_THRESHOLD = 7;
const MAX_STORED_ERROR_MESSAGE_LENGTH = 10000;
const MAX_ERROR_HISTORY_PER_ACCOUNT = 200;

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
 * Get all eligible (active + model-enabled + access-allowed) accounts for a user
 * Does not apply rate limit or failed cooldown filters.
 */
export async function getEligibleAccounts(
  userId: string,
  model: string,
  provider: string | null = null,
  excludeAccountIds: string[] = [],
  accountAccess?: ApiKeyAccountAccess
): Promise<ProviderAccount[]> {
  let targetProviders: string[];

  if (provider !== null) {
    targetProviders = [provider];
  } else {
    targetProviders = getProvidersForModel(model);
    if (targetProviders.length === 0) {
      return [];
    }
  }

  const whereConditions = [
    eq(providerAccount.userId, userId),
    inArray(providerAccount.provider, targetProviders),
    eq(providerAccount.isActive, true),
  ];

  if (excludeAccountIds.length > 0) {
    whereConditions.push(notInArray(providerAccount.id, excludeAccountIds));
  }

  if (accountAccess && accountAccess.mode !== "all" && accountAccess.accounts.length > 0) {
    if (accountAccess.mode === "whitelist") {
      whereConditions.push(inArray(providerAccount.id, accountAccess.accounts));
    } else if (accountAccess.mode === "blacklist") {
      whereConditions.push(notInArray(providerAccount.id, accountAccess.accounts));
    }
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
    return [];
  }

  const modelLookupKeys = getModelLookupKeys(resolveModelAlias(model));
  const disabledEntries = await db
    .select({ providerAccountId: providerAccountDisabledModel.providerAccountId })
    .from(providerAccountDisabledModel)
    .where(
      and(
        inArray(
          providerAccountDisabledModel.providerAccountId,
          accounts.map((a) => a.id)
        ),
        inArray(providerAccountDisabledModel.model, modelLookupKeys)
      )
    );

  const modelDisabledAccountIds = new Set(
    disabledEntries.map((e) => e.providerAccountId)
  );

  if (modelDisabledAccountIds.size === 0) {
    return accounts;
  }

  return accounts.filter((account) => !modelDisabledAccountIds.has(account.id));
}

/**
 * Get the next available (non-rate-limited) account for a user and model using LRU
 * Skips accounts that are rate-limited for the requested model
 * Uses per-model circuit breaker health to filter/deprioritize accounts.
 * Implements half-open state: after cooldown, allows one probe request before fully restoring.
 * @param userId User ID
 * @param model Model name
 * @param provider Optional specific provider
 * @param excludeAccountIds Account IDs to exclude (already tried this request)
 * @param accountAccess Optional API key account access rules (whitelist/blacklist)
 */
export async function getNextAvailableAccount(
  userId: string,
  model: string,
  provider: string | null = null,
  excludeAccountIds: string[] = [],
  accountAccess?: ApiKeyAccountAccess
): Promise<ProviderAccount | null> {
  const eligibleAccounts = await getEligibleAccounts(
    userId,
    model,
    provider,
    excludeAccountIds,
    accountAccess
  );

  if (eligibleAccounts.length === 0) {
    return null;
  }

  const rateLimitScope = getRateLimitScope(model);

  const paidAccounts = eligibleAccounts.filter((a) => a.tier === "paid");
  const freeAccounts = eligibleAccounts.filter((a) => a.tier !== "paid");
  const prioritizedAccounts = [...paidAccounts, ...freeAccounts];

  const rateLimitedAccountIds = await getRateLimitedAccountIds(
    prioritizedAccounts.map((account) => account.id),
    rateLimitScope
  );

  const resolvedModel = resolveModelAlias(model);
  const modelLookupKeys = getModelLookupKeys(resolvedModel);

  const healthRows = prioritizedAccounts.length > 0
    ? await db
        .select()
        .from(providerAccountModelHealth)
        .where(
          and(
            inArray(
              providerAccountModelHealth.providerAccountId,
              prioritizedAccounts.map((a) => a.id)
            ),
            inArray(providerAccountModelHealth.model, modelLookupKeys)
          )
        )
    : [];

  const healthByAccountId = new Map<string, typeof healthRows[number]>();
  for (const row of healthRows) {
    healthByAccountId.set(row.providerAccountId, row);
  }

  const now = Date.now();
  let selectedAccount: ProviderAccount | null = null;

  for (const acc of prioritizedAccounts) {
    if (rateLimitedAccountIds.has(acc.id)) {
      continue;
    }

    const health = healthByAccountId.get(acc.id);
    if (health) {
      if (health.status === "failed") {
        if (health.statusChangedAt) {
          const elapsed = now - health.statusChangedAt.getTime();
          if (elapsed < FAILED_COOLDOWN_MS) {
            continue;
          }
        }
        await db
          .update(providerAccountModelHealth)
          .set({
            status: "half_open",
            statusReason: "cooldown expired, probing",
            statusChangedAt: new Date(),
          })
          .where(eq(providerAccountModelHealth.id, health.id));
      }

      if (health.status === "half_open" || health.status === "degraded") {
        if (!selectedAccount) {
          selectedAccount = acc;
        }
        continue;
      }
    }

    selectedAccount = acc;
    break;
  }

  if (!selectedAccount) {
    return null;
  }

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
 * Mark an account as having failed for a specific model.
 * Per-model circuit breaker with half-open state:
 * - 3+ consecutive errors: "degraded" (deprioritized)
 * - 7+ consecutive errors: "failed" (sidelined until cooldown)
 * - If in "half_open" and error occurs: back to "failed" with fresh cooldown
 */
export async function markAccountFailed(
  accountId: string,
  model: string,
  errorCode: number,
  errorMessage: string
): Promise<void> {
  const normalizedErrorMessage = errorMessage.slice(0, MAX_STORED_ERROR_MESSAGE_LENGTH);
  const resolvedModel = resolveModelAlias(model);

  await db
    .update(providerAccount)
    .set({
      errorCount: sql`${providerAccount.errorCount} + 1`,
      lastErrorAt: new Date(),
      lastErrorMessage: normalizedErrorMessage,
      lastErrorCode: errorCode,
    })
    .where(eq(providerAccount.id, accountId));

  const now = new Date();
  const [health] = await db
    .insert(providerAccountModelHealth)
    .values({
      providerAccountId: accountId,
      model: resolvedModel,
      consecutiveErrors: 1,
      lastErrorAt: now,
      lastErrorCode: errorCode,
      lastErrorMessage: normalizedErrorMessage,
    })
    .onConflictDoUpdate({
      target: [providerAccountModelHealth.providerAccountId, providerAccountModelHealth.model],
      set: {
        consecutiveErrors: sql`${providerAccountModelHealth.consecutiveErrors} + 1`,
        lastErrorAt: now,
        lastErrorCode: errorCode,
        lastErrorMessage: normalizedErrorMessage,
      },
    })
    .returning();

  const newConsecutiveErrors = health.consecutiveErrors;
  const currentStatus = health.status;
  let newStatus: string | null = null;
  let statusReason: string | null = null;

  if (currentStatus === "half_open") {
    newStatus = "failed";
    statusReason = `probe failed during half-open (${resolvedModel})`;
  } else if (newConsecutiveErrors >= FAILED_THRESHOLD && currentStatus !== "failed") {
    newStatus = "failed";
    statusReason = `${newConsecutiveErrors} consecutive errors on ${resolvedModel}`;
  } else if (newConsecutiveErrors >= DEGRADED_THRESHOLD && currentStatus === "active") {
    newStatus = "degraded";
    statusReason = `${newConsecutiveErrors} consecutive errors on ${resolvedModel}`;
  }

  if (newStatus) {
    await db
      .update(providerAccountModelHealth)
      .set({
        status: newStatus,
        statusReason,
        statusChangedAt: now,
      })
      .where(eq(providerAccountModelHealth.id, health.id));
  }

  const [account] = await db
    .select({ userId: providerAccount.userId })
    .from(providerAccount)
    .where(eq(providerAccount.id, accountId))
    .limit(1);

  if (account) {
    await db.insert(providerAccountErrorHistory).values({
      providerAccountId: accountId,
      userId: account.userId,
      model: resolvedModel,
      errorCode,
      errorMessage: normalizedErrorMessage,
    });

    const staleHistoryEntries = await db
      .select({ id: providerAccountErrorHistory.id })
      .from(providerAccountErrorHistory)
      .where(eq(providerAccountErrorHistory.providerAccountId, accountId))
      .orderBy(
        desc(providerAccountErrorHistory.createdAt),
        desc(providerAccountErrorHistory.id)
      )
      .offset(MAX_ERROR_HISTORY_PER_ACCOUNT);

    if (staleHistoryEntries.length > 0) {
      await db
        .delete(providerAccountErrorHistory)
        .where(
          inArray(
            providerAccountErrorHistory.id,
            staleHistoryEntries.map((entry) => entry.id)
          )
        );
    }
  }
}

/**
 * Mark an account as having succeeded for a specific model.
 * Resets per-model consecutive errors and restores health status.
 * Half-open -> active on success (circuit closes).
 */
export async function markAccountSuccess(
  accountId: string,
  model: string
): Promise<void> {
  const resolvedModel = resolveModelAlias(model);

  await db
    .update(providerAccount)
    .set({
      successCount: sql`${providerAccount.successCount} + 1`,
      lastSuccessAt: new Date(),
    })
    .where(eq(providerAccount.id, accountId));

  const [existingHealth] = await db
    .select()
    .from(providerAccountModelHealth)
    .where(
      and(
        eq(providerAccountModelHealth.providerAccountId, accountId),
        eq(providerAccountModelHealth.model, resolvedModel)
      )
    )
    .limit(1);

  if (!existingHealth) {
    return;
  }

  const updates: Record<string, unknown> = {
    consecutiveErrors: 0,
    lastSuccessAt: new Date(),
  };

  if (
    existingHealth.status === "degraded" ||
    existingHealth.status === "failed" ||
    existingHealth.status === "half_open"
  ) {
    updates.status = "active";
    updates.statusReason = null;
    updates.statusChangedAt = new Date();
  }

  await db
    .update(providerAccountModelHealth)
    .set(updates)
    .where(eq(providerAccountModelHealth.id, existingHealth.id));
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
