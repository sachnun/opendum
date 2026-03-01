import { Effect } from "effect";
import { DatabaseService, RedisService } from "@/lib/effect/services";
import { DatabaseError } from "@/lib/effect/errors";
import { runWithInfra } from "@/lib/effect/runtime";
import { providerAccount, providerAccountErrorHistory } from "@/lib/db/schema";
import { eq, and, inArray, notInArray, asc, desc, sql } from "drizzle-orm";
import type { ProviderAccount } from "@/lib/db/schema";
import { getProvidersForModel } from "./models";
import { getRateLimitedAccountIds as getRateLimitedAccountIdsAsync, getRateLimitScope } from "./rate-limit";

const FAILED_ACCOUNT_RETRY_COOLDOWN_MS = 10 * 60 * 1000;
const MAX_STORED_ERROR_MESSAGE_LENGTH = 10000;
const MAX_ERROR_HISTORY_PER_ACCOUNT = 200;

// ---------------------------------------------------------------------------
// Effect-based internal operations
// ---------------------------------------------------------------------------

const getNextAccountEffect = (
  userId: string,
  model: string,
  provider: string | null = null
): Effect.Effect<ProviderAccount | null, DatabaseError, DatabaseService> =>
  Effect.gen(function* () {
    const db = yield* DatabaseService;
    let targetProviders: string[];

    if (provider !== null) {
      targetProviders = [provider];
    } else {
      targetProviders = getProvidersForModel(model);
      if (targetProviders.length === 0) {
        return null;
      }
    }

    const accounts = yield* Effect.tryPromise({
      try: () =>
        db
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
          .limit(1),
      catch: (cause) => new DatabaseError({ cause }),
    });

    const selectedAccount = accounts[0];
    if (!selectedAccount) {
      return null;
    }

    yield* Effect.tryPromise({
      try: () =>
        db
          .update(providerAccount)
          .set({
            lastUsedAt: new Date(),
            requestCount: sql`${providerAccount.requestCount} + 1`,
          })
          .where(eq(providerAccount.id, selectedAccount.id)),
      catch: (cause) => new DatabaseError({ cause }),
    });

    return selectedAccount;
  });

const getNextAvailableAccountEffect = (
  userId: string,
  model: string,
  provider: string | null = null,
  excludeAccountIds: string[] = []
): Effect.Effect<ProviderAccount | null, DatabaseError, DatabaseService | RedisService> =>
  Effect.gen(function* () {
    const db = yield* DatabaseService;
    let targetProviders: string[];

    if (provider !== null) {
      targetProviders = [provider];
    } else {
      targetProviders = getProvidersForModel(model);
      if (targetProviders.length === 0) {
        return null;
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

    const accounts = yield* Effect.tryPromise({
      try: () =>
        db
          .select()
          .from(providerAccount)
          .where(and(...whereConditions))
          .orderBy(
            asc(providerAccount.status),
            sql`${providerAccount.lastUsedAt} ASC NULLS FIRST`,
            asc(providerAccount.createdAt)
          ),
      catch: (cause) => new DatabaseError({ cause }),
    });

    if (accounts.length === 0) {
      return null;
    }

    const rateLimitScope = getRateLimitScope(model);

    // Separate paid and free accounts (both already sorted by status then LRU)
    const paidAccounts = accounts.filter((a) => a.tier === "paid");
    const freeAccounts = accounts.filter((a) => a.tier !== "paid");

    let selectedAccount: ProviderAccount | null = null;
    const now = Date.now();
    const prioritizedAccounts = [...paidAccounts, ...freeAccounts];

    // getRateLimitedAccountIds is already fail-open (returns empty set on Redis error)
    const rateLimitedAccountIds = yield* Effect.tryPromise({
      try: () =>
        getRateLimitedAccountIdsAsync(
          prioritizedAccounts.map((account) => account.id),
          rateLimitScope
        ),
      catch: () => new Set<string>(),
    }).pipe(Effect.catchAll(() => Effect.succeed(new Set<string>())));

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

    yield* Effect.tryPromise({
      try: () =>
        db
          .update(providerAccount)
          .set({
            lastUsedAt: new Date(),
            requestCount: sql`${providerAccount.requestCount} + 1`,
          })
          .where(eq(providerAccount.id, selectedAccount!.id)),
      catch: (cause) => new DatabaseError({ cause }),
    });

    return selectedAccount;
  });

const getNextAccountForProviderEffect = (
  userId: string,
  provider: string
): Effect.Effect<ProviderAccount | null, DatabaseError, DatabaseService> =>
  Effect.gen(function* () {
    const db = yield* DatabaseService;

    const accounts = yield* Effect.tryPromise({
      try: () =>
        db
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
          .limit(1),
      catch: (cause) => new DatabaseError({ cause }),
    });

    const selectedAccount = accounts[0];
    if (!selectedAccount) {
      return null;
    }

    yield* Effect.tryPromise({
      try: () =>
        db
          .update(providerAccount)
          .set({
            lastUsedAt: new Date(),
            requestCount: sql`${providerAccount.requestCount} + 1`,
          })
          .where(eq(providerAccount.id, selectedAccount.id)),
      catch: (cause) => new DatabaseError({ cause }),
    });

    return selectedAccount;
  });

const markAccountFailedEffect = (
  accountId: string,
  errorCode: number,
  errorMessage: string
): Effect.Effect<void, DatabaseError, DatabaseService> =>
  Effect.gen(function* () {
    const db = yield* DatabaseService;
    const normalizedErrorMessage = errorMessage.slice(0, MAX_STORED_ERROR_MESSAGE_LENGTH);

    const updatedAccounts = yield* Effect.tryPromise({
      try: () =>
        db
          .update(providerAccount)
          .set({
            errorCount: sql`${providerAccount.errorCount} + 1`,
            consecutiveErrors: sql`${providerAccount.consecutiveErrors} + 1`,
            lastErrorAt: new Date(),
            lastErrorMessage: normalizedErrorMessage,
            lastErrorCode: errorCode,
          })
          .where(eq(providerAccount.id, accountId))
          .returning(),
      catch: (cause) => new DatabaseError({ cause }),
    });

    const account = updatedAccounts[0];
    if (!account) {
      return;
    }

    yield* Effect.tryPromise({
      try: () =>
        db.insert(providerAccountErrorHistory).values({
          providerAccountId: accountId,
          userId: account.userId,
          errorCode,
          errorMessage: normalizedErrorMessage,
        }),
      catch: (cause) => new DatabaseError({ cause }),
    });

    const staleHistoryEntries = yield* Effect.tryPromise({
      try: () =>
        db
          .select({ id: providerAccountErrorHistory.id })
          .from(providerAccountErrorHistory)
          .where(eq(providerAccountErrorHistory.providerAccountId, accountId))
          .orderBy(
            desc(providerAccountErrorHistory.createdAt),
            desc(providerAccountErrorHistory.id)
          )
          .offset(MAX_ERROR_HISTORY_PER_ACCOUNT),
      catch: (cause) => new DatabaseError({ cause }),
    });

    if (staleHistoryEntries.length > 0) {
      yield* Effect.tryPromise({
        try: () =>
          db
            .delete(providerAccountErrorHistory)
            .where(
              inArray(
                providerAccountErrorHistory.id,
                staleHistoryEntries.map((entry) => entry.id)
              )
            ),
        catch: (cause) => new DatabaseError({ cause }),
      });
    }

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
      yield* Effect.tryPromise({
        try: () =>
          db
            .update(providerAccount)
            .set({
              status: newStatus!,
              statusReason,
              statusChangedAt: new Date(),
            })
            .where(eq(providerAccount.id, accountId)),
        catch: (cause) => new DatabaseError({ cause }),
      });
    }
  });

const markAccountSuccessEffect = (
  accountId: string
): Effect.Effect<void, DatabaseError, DatabaseService> =>
  Effect.gen(function* () {
    const db = yield* DatabaseService;

    const accounts = yield* Effect.tryPromise({
      try: () =>
        db
          .select({
            status: providerAccount.status,
            consecutiveErrors: providerAccount.consecutiveErrors,
          })
          .from(providerAccount)
          .where(eq(providerAccount.id, accountId))
          .limit(1),
      catch: (cause) => new DatabaseError({ cause }),
    });

    const account = accounts[0];
    if (!account) return;

    const updates: Record<string, unknown> = {
      consecutiveErrors: 0,
      successCount: sql`${providerAccount.successCount} + 1`,
      lastSuccessAt: new Date(),
    };

    if (account.status === "degraded" || account.status === "failed") {
      updates.status = "active";
      updates.statusReason = null;
      updates.statusChangedAt = new Date();
    }

    yield* Effect.tryPromise({
      try: () =>
        db
          .update(providerAccount)
          .set(updates)
          .where(eq(providerAccount.id, accountId)),
      catch: (cause) => new DatabaseError({ cause }),
    });
  });

const getAccountStatsEffect = (
  userId: string
): Effect.Effect<
  {
    totalAccounts: number;
    activeAccounts: number;
    totalRequests: number;
    byProvider: Record<string, { total: number; active: number; requests: number }>;
  },
  DatabaseError,
  DatabaseService
> =>
  Effect.gen(function* () {
    const db = yield* DatabaseService;

    const accounts = yield* Effect.tryPromise({
      try: () =>
        db
          .select({
            provider: providerAccount.provider,
            isActive: providerAccount.isActive,
            requestCount: providerAccount.requestCount,
          })
          .from(providerAccount)
          .where(eq(providerAccount.userId, userId)),
      catch: (cause) => new DatabaseError({ cause }),
    });

    const byProvider: Record<string, { total: number; active: number; requests: number }> = {};

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
  });

const getAccountsByProviderEffect = (
  userId: string
): Effect.Effect<Record<string, ProviderAccount[]>, DatabaseError, DatabaseService> =>
  Effect.gen(function* () {
    const db = yield* DatabaseService;

    const accounts = yield* Effect.tryPromise({
      try: () =>
        db
          .select()
          .from(providerAccount)
          .where(eq(providerAccount.userId, userId))
          .orderBy(asc(providerAccount.createdAt)),
      catch: (cause) => new DatabaseError({ cause }),
    });

    const grouped: Record<string, ProviderAccount[]> = {};

    for (const account of accounts) {
      if (!grouped[account.provider]) {
        grouped[account.provider] = [];
      }
      grouped[account.provider].push(account);
    }

    return grouped;
  });

// ---------------------------------------------------------------------------
// Public API — signatures unchanged
// ---------------------------------------------------------------------------

/**
 * Get the next active provider account for a user and model using LRU (Least Recently Used)
 * Selects the account that was used longest ago (or never used) for fair distribution
 */
export async function getNextAccount(
  userId: string,
  model: string,
  provider: string | null = null
): Promise<ProviderAccount | null> {
  return runWithInfra(
    getNextAccountEffect(userId, model, provider).pipe(
      Effect.catchTag("DatabaseError", () => Effect.succeed(null))
    )
  );
}

/**
 * Get the next available (non-rate-limited) account for a user and model using LRU
 * Skips accounts that are rate-limited for the requested model
 * Deprioritizes degraded and failed accounts.
 * Failed accounts are retried automatically after a cooldown window.
 */
export async function getNextAvailableAccount(
  userId: string,
  model: string,
  provider: string | null = null,
  excludeAccountIds: string[] = []
): Promise<ProviderAccount | null> {
  return runWithInfra(
    getNextAvailableAccountEffect(userId, model, provider, excludeAccountIds).pipe(
      Effect.catchTag("DatabaseError", () => Effect.succeed(null))
    )
  );
}

/**
 * Get the next active account for a specific provider using LRU
 */
export async function getNextAccountForProvider(
  userId: string,
  provider: string
): Promise<ProviderAccount | null> {
  return runWithInfra(
    getNextAccountForProviderEffect(userId, provider).pipe(
      Effect.catchTag("DatabaseError", () => Effect.succeed(null))
    )
  );
}

/**
 * Mark an account as having failed with error details
 * Auto-degrades status based on consecutive error count
 */
export async function markAccountFailed(
  accountId: string,
  errorCode: number,
  errorMessage: string
): Promise<void> {
  return runWithInfra(
    markAccountFailedEffect(accountId, errorCode, errorMessage).pipe(
      Effect.catchTag("DatabaseError", () => Effect.void)
    )
  );
}

/**
 * Mark an account as having succeeded
 * Resets consecutive errors and restores status to "active" if it was degraded/failed
 */
export async function markAccountSuccess(accountId: string): Promise<void> {
  return runWithInfra(
    markAccountSuccessEffect(accountId).pipe(
      Effect.catchTag("DatabaseError", () => Effect.void)
    )
  );
}

/**
 * Get account stats for a user
 */
export async function getAccountStats(userId: string): Promise<{
  totalAccounts: number;
  activeAccounts: number;
  totalRequests: number;
  byProvider: Record<string, { total: number; active: number; requests: number }>;
}> {
  return runWithInfra(
    getAccountStatsEffect(userId).pipe(
      Effect.catchTag("DatabaseError", () =>
        Effect.succeed({
          totalAccounts: 0,
          activeAccounts: 0,
          totalRequests: 0,
          byProvider: {},
        })
      )
    )
  );
}

/**
 * Get all accounts for a user grouped by provider
 */
export async function getAccountsByProvider(
  userId: string
): Promise<Record<string, ProviderAccount[]>> {
  return runWithInfra(
    getAccountsByProviderEffect(userId).pipe(
      Effect.catchTag("DatabaseError", () => Effect.succeed({}))
    )
  );
}
