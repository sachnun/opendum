import { db } from "../lib/db";
import { pinnedProvider, providerAccount, providerAccountDisabledModel, providerAccountErrorHistory, providerAccountModelHealth } from "../lib/db/schema";
import { getModelFamily, getModelLookupKeys, getProviderModelSet, resolveModelAlias } from "../lib/proxy/models";
import { invalidateDisabledModelsCache } from "../lib/proxy/auth";
import { compareModelEntries } from "../../lib/model-sort";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { isKnownProvider, PROVIDER_ACCOUNT_KEYS, type ProviderAccountKey } from "./account-providers";
import { buildAccountStats, getAccountIndicator, getProviderSummaryStats, INDICATOR_WEIGHT, type ProviderAccountIndicator, type ProviderStats } from "./account-stats";

export { createAccount, createAccountInputSchema } from "./account-connectors";

const AUTO_PIN_SENTINEL = "_auto_pinned";
const ACCOUNT_HEALTH_STATUS_WEIGHT: Record<string, number> = { active: 0, degraded: 1, half_open: 2, failed: 3 };
const FAILED_COOLDOWN_MS = 10 * 60 * 1000;
const INITIAL_DEGRADED_CONSECUTIVE_ERRORS = 3;
const MAX_ERROR_HISTORY_ROWS = 8;

type AccountSummarySourceRow = {
  provider: string;
  isActive: boolean;
  disabledUntil: Date | string | null;
  lastUsedAt: Date | string | null;
  lastErrorAt: Date | string | null;
  lastSuccessAt: Date | string | null;
  lastRecoveredByRotationAt: Date | string | null;
};

export const providerInputSchema = z.object({
  provider: z.string().refine(isKnownProvider, "Invalid provider"),
});
export const updateAccountInputSchema = z.object({ id: z.string(), name: z.string().optional(), isActive: z.boolean().optional(), disabledUntil: z.coerce.date().nullable().optional() });
export const deleteAccountInputSchema = z.object({ id: z.string() });
export const togglePinnedProviderInputSchema = z.object({ providerKey: z.string() });
export const setAccountModelEnabledInputSchema = z.object({ accountId: z.string(), modelId: z.string(), enabled: z.boolean() });
export const errorHistoryInputSchema = z.object({ accountId: z.string(), limit: z.coerce.number().int().min(1).max(200).optional() });
export const resolveErrorsInputSchema = z.object({ accountId: z.string() });

const providerAccountListColumns = {
  id: providerAccount.id,
  provider: providerAccount.provider,
  name: providerAccount.name,
  email: providerAccount.email,
  isActive: providerAccount.isActive,
  disabledUntil: providerAccount.disabledUntil,
  lastUsedAt: providerAccount.lastUsedAt,
  expiresAt: providerAccount.expiresAt,
  requestCount: providerAccount.requestCount,
  tier: providerAccount.tier,
  status: providerAccount.status,
  statusChangedAt: providerAccount.statusChangedAt,
  errorCount: providerAccount.errorCount,
  consecutiveErrors: providerAccount.consecutiveErrors,
  lastErrorAt: providerAccount.lastErrorAt,
  lastSuccessAt: providerAccount.lastSuccessAt,
  lastRecoveredByRotationAt: providerAccount.lastRecoveredByRotationAt,
  lastErrorMessage: providerAccount.lastErrorMessage,
  lastErrorCode: providerAccount.lastErrorCode,
  successCount: providerAccount.successCount,
  createdAt: providerAccount.createdAt,
};

function accountIsEffectivelyActive(account: { isActive: boolean; disabledUntil: Date | string | null }, now = new Date()): boolean {
  if (!account.isActive) return false;
  if (!account.disabledUntil) return true;

  const disabledUntil = account.disabledUntil instanceof Date ? account.disabledUntil : new Date(account.disabledUntil);
  return Number.isNaN(disabledUntil.getTime()) || disabledUntil <= now;
}

function withEffectiveActive<T extends { isActive: boolean; disabledUntil: Date | string | null }>(account: T, now = new Date()): T {
  return { ...account, isActive: accountIsEffectivelyActive(account, now) };
}

function withEffectiveHealthStatus<T extends { status: string; statusChangedAt?: Date | string | null }>(row: T, now = new Date()): T {
  if (row.status !== "failed" || !row.statusChangedAt) return row;

  const statusChangedAt = row.statusChangedAt instanceof Date ? row.statusChangedAt : new Date(row.statusChangedAt);
  if (Number.isNaN(statusChangedAt.getTime()) || now.getTime() - statusChangedAt.getTime() < FAILED_COOLDOWN_MS) return row;

  return { ...row, status: "degraded" };
}

function buildAccountPingSummaries(accounts: AccountSummarySourceRow[], now = new Date()) {
  const summaries = Object.fromEntries(
    PROVIDER_ACCOUNT_KEYS.map((provider) => [
      provider,
      {
        connected: 0,
        active: 0,
        indicator: "normal" as ProviderAccountIndicator,
      },
    ])
  ) as Record<ProviderAccountKey, { connected: number; active: number; indicator: ProviderAccountIndicator }>;

  for (const account of accounts) {
    if (!isKnownProvider(account.provider)) continue;

    const summary = summaries[account.provider];
    summary.connected += 1;

    if (!accountIsEffectivelyActive(account, now)) continue;

    summary.active += 1;
    const indicator = getAccountIndicator(account.lastErrorAt, account.lastSuccessAt, account.lastRecoveredByRotationAt, account.lastUsedAt);
    if (INDICATOR_WEIGHT[indicator] > INDICATOR_WEIGHT[summary.indicator]) {
      summary.indicator = indicator;
    }
  }

  return summaries;
}

async function getPinnedProviderKeys(userId: string, providersWithAccounts?: Iterable<string>): Promise<ProviderAccountKey[]> {
  const rows = await db.select({ providerKey: pinnedProvider.providerKey }).from(pinnedProvider).where(eq(pinnedProvider.userId, userId)).orderBy(asc(pinnedProvider.createdAt));

  if (rows.length === 0 && providersWithAccounts) {
    const providerSet = new Set(providersWithAccounts);
    const autoPinKeys = PROVIDER_ACCOUNT_KEYS.filter((provider) => providerSet.has(provider)).slice(0, 5);
    const rowsToInsert = [
      ...autoPinKeys.map((providerKey) => ({ userId, providerKey })),
      { userId, providerKey: AUTO_PIN_SENTINEL },
    ];

    if (rowsToInsert.length > 0) {
      await db.insert(pinnedProvider).values(rowsToInsert).onConflictDoNothing({ target: [pinnedProvider.userId, pinnedProvider.providerKey] });
    }

    return autoPinKeys;
  }

  return rows.map((row) => row.providerKey).filter((provider): provider is ProviderAccountKey => isKnownProvider(provider));
}

export async function listAccounts(userId: string) {
  try {
    const now = new Date();
    const accounts = await db.select(providerAccountListColumns).from(providerAccount).where(eq(providerAccount.userId, userId)).orderBy(asc(providerAccount.createdAt));
    return accounts.map((account) => withEffectiveActive(account, now));
  } catch (error) {
    console.error("Failed to list accounts:", error);
    throw new Error("Failed to list accounts");
  }
}

export async function listAccountsByProvider(userId: string, input: z.infer<typeof providerInputSchema>) {
  try {
    const now = new Date();
    const accounts = await db.select(providerAccountListColumns).from(providerAccount).where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, input.provider))).orderBy(desc(providerAccount.createdAt));
    return accounts.map((account) => withEffectiveActive(account, now));
  } catch (error) {
    console.error("Failed to list provider accounts:", error);
    throw new Error("Failed to list provider accounts");
  }
}

export async function getAccountOverview(userId: string) {
  try {
    const now = new Date();
    const [accounts, providerStats] = await Promise.all([
      db
        .select({
          provider: providerAccount.provider,
          isActive: providerAccount.isActive,
          disabledUntil: providerAccount.disabledUntil,
          lastUsedAt: providerAccount.lastUsedAt,
          lastErrorAt: providerAccount.lastErrorAt,
          lastSuccessAt: providerAccount.lastSuccessAt,
          lastRecoveredByRotationAt: providerAccount.lastRecoveredByRotationAt,
        })
        .from(providerAccount)
        .where(eq(providerAccount.userId, userId)),
      getProviderSummaryStats(userId),
    ]);
    const pinnedProviders = await getPinnedProviderKeys(userId, accounts.map((account) => account.provider));
    const pingSummaries = buildAccountPingSummaries(accounts, now);

    const summaries = Object.fromEntries(
      PROVIDER_ACCOUNT_KEYS.map((provider) => [
        provider,
        {
          ...pingSummaries[provider],
          stats: providerStats[provider],
        },
      ])
    ) as Record<ProviderAccountKey, { connected: number; active: number; indicator: ProviderAccountIndicator; stats: ProviderStats }>;

    return { summaries, pinnedProviders };
  } catch (error) {
    console.error("Failed to load account summaries:", error);
    throw new Error("Failed to load account summaries");
  }
}

export async function getAccountPing(userId: string) {
  try {
    const now = new Date();
    const accounts = await db
      .select({
        provider: providerAccount.provider,
        isActive: providerAccount.isActive,
        disabledUntil: providerAccount.disabledUntil,
        lastUsedAt: providerAccount.lastUsedAt,
        lastErrorAt: providerAccount.lastErrorAt,
        lastSuccessAt: providerAccount.lastSuccessAt,
        lastRecoveredByRotationAt: providerAccount.lastRecoveredByRotationAt,
      })
      .from(providerAccount)
      .where(eq(providerAccount.userId, userId));
    const pinnedProviders = await getPinnedProviderKeys(userId, accounts.map((account) => account.provider));
    const pingSummaries = buildAccountPingSummaries(accounts, now);

    return {
      summaries: Object.fromEntries(pinnedProviders.map((provider) => [provider, pingSummaries[provider]])),
      pinnedProviders,
      hasConnectedAccounts: accounts.some((account) => isKnownProvider(account.provider)),
    };
  } catch (error) {
    console.error("Failed to ping account summaries:", error);
    throw new Error("Failed to ping account summaries");
  }
}

export async function getAccountsByProviderDetailed(userId: string, input: z.infer<typeof providerInputSchema>) {
  try {
    const now = new Date();
    const accounts = await db
      .select(providerAccountListColumns)
      .from(providerAccount)
      .where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, input.provider)))
      .orderBy(desc(providerAccount.createdAt));

    const accountIds = accounts.map((account) => account.id);
    const supportedModels = Array.from(getProviderModelSet(input.provider)).sort((a, b) => compareModelEntries({ id: a, family: getModelFamily(a) }, { id: b, family: getModelFamily(b) }));
    const healthModelKeys = Array.from(new Set(supportedModels.flatMap((model) => getModelLookupKeys(model))));
    const [accountStatsById, disabledModelRows, healthRows, pinnedProviders] = await Promise.all([
      buildAccountStats(userId, accountIds),
      accountIds.length > 0
        ? db
            .select({ providerAccountId: providerAccountDisabledModel.providerAccountId, model: providerAccountDisabledModel.model })
            .from(providerAccountDisabledModel)
            .where(inArray(providerAccountDisabledModel.providerAccountId, accountIds))
        : Promise.resolve([]),
      accountIds.length > 0 && healthModelKeys.length > 0
        ? db
            .select({
              providerAccountId: providerAccountModelHealth.providerAccountId,
              model: providerAccountModelHealth.model,
              status: providerAccountModelHealth.status,
              statusChangedAt: providerAccountModelHealth.statusChangedAt,
              consecutiveErrors: providerAccountModelHealth.consecutiveErrors,
              lastErrorAt: providerAccountModelHealth.lastErrorAt,
              lastErrorMessage: providerAccountModelHealth.lastErrorMessage,
              lastErrorCode: providerAccountModelHealth.lastErrorCode,
              lastSuccessAt: providerAccountModelHealth.lastSuccessAt,
            })
            .from(providerAccountModelHealth)
            .where(and(inArray(providerAccountModelHealth.providerAccountId, accountIds), inArray(providerAccountModelHealth.model, healthModelKeys)))
        : Promise.resolve([]),
      getPinnedProviderKeys(userId),
    ]);

    const disabledModelsByAccountId = disabledModelRows.reduce<Record<string, string[]>>((acc, row) => {
      acc[row.providerAccountId] = [...(acc[row.providerAccountId] ?? []), row.model];
      return acc;
    }, {});

    const effectiveHealthRows = healthRows.map((row) => withEffectiveHealthStatus(row, now));
    const healthByAccountId = effectiveHealthRows.reduce<Record<string, (typeof effectiveHealthRows)[number]>>((acc, row) => {
      const current = acc[row.providerAccountId];
      const currentWeight = current ? ACCOUNT_HEALTH_STATUS_WEIGHT[current.status] ?? 0 : 0;
      const nextWeight = ACCOUNT_HEALTH_STATUS_WEIGHT[row.status] ?? 0;
      if (nextWeight > currentWeight || (nextWeight === currentWeight && row.consecutiveErrors > (current?.consecutiveErrors ?? 0))) {
        acc[row.providerAccountId] = row;
      }
      return acc;
    }, {});
    const modelHealthByAccountId = effectiveHealthRows.reduce<Record<string, Record<string, { status: string; consecutiveErrors: number; lastErrorAt: Date | string | null; lastSuccessAt: Date | string | null }>>>((acc, row) => {
      const model = resolveModelAlias(row.model);
      const accountHealth = acc[row.providerAccountId] ?? {};
      const current = accountHealth[model];
      const currentWeight = current ? ACCOUNT_HEALTH_STATUS_WEIGHT[current.status] ?? 0 : 0;
      const nextWeight = ACCOUNT_HEALTH_STATUS_WEIGHT[row.status] ?? 0;
      if (!current || nextWeight > currentWeight || (nextWeight === currentWeight && row.consecutiveErrors > current.consecutiveErrors)) {
        accountHealth[model] = {
          status: row.status,
          consecutiveErrors: row.consecutiveErrors,
          lastErrorAt: row.lastErrorAt,
          lastSuccessAt: row.lastSuccessAt,
        };
        acc[row.providerAccountId] = accountHealth;
      }
      return acc;
    }, {});

    return {
      accounts: accounts.map((account) => {
        const effectiveAccount = withEffectiveHealthStatus(account, now);
        const health = healthByAccountId[effectiveAccount.id];
        const accountWeight = ACCOUNT_HEALTH_STATUS_WEIGHT[effectiveAccount.status] ?? 0;
        const healthWeight = health ? ACCOUNT_HEALTH_STATUS_WEIGHT[health.status] ?? 0 : 0;
        const useModelHealth = health && (healthWeight > accountWeight || (healthWeight === accountWeight && health.consecutiveErrors > effectiveAccount.consecutiveErrors));

        return {
          ...withEffectiveActive(effectiveAccount, now),
          ...(useModelHealth
            ? {
                status: health.status,
                statusChangedAt: health.statusChangedAt,
                consecutiveErrors: health.consecutiveErrors,
                lastErrorAt: health.lastErrorAt ?? account.lastErrorAt,
                lastErrorMessage: health.lastErrorMessage ?? account.lastErrorMessage,
                lastErrorCode: health.lastErrorCode ?? account.lastErrorCode,
                lastSuccessAt: health.lastSuccessAt ?? account.lastSuccessAt,
              }
            : {}),
          stats: accountStatsById[account.id],
        };
      }),
      supportedModels,
      disabledModelsByAccountId,
      modelHealthByAccountId,
      pinnedProviders,
    };
  } catch (error) {
    console.error("Failed to load provider account detail:", error);
    throw new Error("Failed to load provider account detail");
  }
}

export async function updateAccount(userId: string, input: z.infer<typeof updateAccountInputSchema>) {
    try {
      const [account] = await db.select({ id: providerAccount.id }).from(providerAccount).where(and(eq(providerAccount.id, input.id), eq(providerAccount.userId, userId))).limit(1);
      if (!account) return { success: false, error: "Account not found" } as const;

      const updates: { name?: string; isActive?: boolean; disabledUntil?: Date | null } = {};
      const manuallyReenabled = input.isActive === true || input.disabledUntil === null;
      const now = new Date();
      if (input.name !== undefined) {
        const name = input.name.trim();
        if (!name) return { success: false, error: "Please enter a name" } as const;
        updates.name = name;
      }

      if (input.disabledUntil instanceof Date) {
        if (input.disabledUntil <= now) return { success: false, error: "Please choose a future time" } as const;
        updates.isActive = true;
        updates.disabledUntil = input.disabledUntil;
      } else {
        if (input.isActive !== undefined) {
          updates.isActive = input.isActive;
          updates.disabledUntil = null;
        } else if (input.disabledUntil === null) {
          updates.disabledUntil = null;
        }
      }

      if (Object.keys(updates).length > 0) {
        await db.update(providerAccount).set(updates).where(eq(providerAccount.id, input.id));
        if (manuallyReenabled) await downgradeAccountFailureForManualEnable(input.id, now);
        if (updates.isActive !== undefined || updates.disabledUntil !== undefined) await invalidateDisabledModelsCache(userId);
      }

      const [updated] = await db
        .select({ id: providerAccount.id, name: providerAccount.name, isActive: providerAccount.isActive, disabledUntil: providerAccount.disabledUntil, status: providerAccount.status, statusChangedAt: providerAccount.statusChangedAt, consecutiveErrors: providerAccount.consecutiveErrors })
        .from(providerAccount)
        .where(eq(providerAccount.id, input.id))
        .limit(1);
      if (!updated) return { success: false, error: "Account not found" } as const;

      return { success: true, data: withEffectiveActive(updated, now) } as const;
    } catch (error) {
      console.error("Failed to update account:", error);
      return { success: false, error: "Failed to update account" } as const;
    }
}

async function downgradeAccountFailureForManualEnable(accountId: string, now = new Date()): Promise<void> {
  await Promise.all([
    db
      .update(providerAccount)
      .set({ status: "degraded", statusChangedAt: now, consecutiveErrors: INITIAL_DEGRADED_CONSECUTIVE_ERRORS })
      .where(and(eq(providerAccount.id, accountId), inArray(providerAccount.status, ["failed", "half_open", "degraded"]))),
    db
      .update(providerAccountModelHealth)
      .set({ status: "degraded", statusChangedAt: now, consecutiveErrors: INITIAL_DEGRADED_CONSECUTIVE_ERRORS })
      .where(and(eq(providerAccountModelHealth.providerAccountId, accountId), inArray(providerAccountModelHealth.status, ["failed", "half_open", "degraded"]))),
  ]);
}

export async function deleteAccount(userId: string, input: z.infer<typeof deleteAccountInputSchema>) {
  try {
    const [account] = await db.select({ id: providerAccount.id }).from(providerAccount).where(and(eq(providerAccount.id, input.id), eq(providerAccount.userId, userId))).limit(1);
    if (!account) return { success: false, error: "Account not found" } as const;

    await db.delete(providerAccount).where(eq(providerAccount.id, input.id));
    await invalidateDisabledModelsCache(userId);
    return { success: true, data: undefined } as const;
  } catch (error) {
    console.error("Failed to delete account:", error);
    return { success: false, error: "Failed to delete account" } as const;
  }
}

export async function togglePinnedProvider(userId: string, input: z.infer<typeof togglePinnedProviderInputSchema>) {
  if (!isKnownProvider(input.providerKey)) return { success: false, error: "Invalid provider" } as const;

  try {
    const [existing] = await db
      .select({ id: pinnedProvider.id })
      .from(pinnedProvider)
      .where(and(eq(pinnedProvider.userId, userId), eq(pinnedProvider.providerKey, input.providerKey)))
      .limit(1);

    if (existing) {
      await db.delete(pinnedProvider).where(eq(pinnedProvider.id, existing.id));
      return { success: true, data: { providerKey: input.providerKey, pinned: false } } as const;
    }

    await db.insert(pinnedProvider).values({ userId, providerKey: input.providerKey }).onConflictDoNothing({ target: [pinnedProvider.userId, pinnedProvider.providerKey] });
    return { success: true, data: { providerKey: input.providerKey, pinned: true } } as const;
  } catch (error) {
    console.error("Failed to toggle pinned provider:", error);
    return { success: false, error: "Failed to update pinned provider" } as const;
  }
}

export async function setAccountModelEnabled(userId: string, input: z.infer<typeof setAccountModelEnabledInputSchema>) {
  try {
    const [account] = await db
      .select({ id: providerAccount.id, provider: providerAccount.provider })
      .from(providerAccount)
      .where(and(eq(providerAccount.id, input.accountId), eq(providerAccount.userId, userId)))
      .limit(1);
    if (!account) return { success: false, error: "Account not found" } as const;

    const normalizedModel = resolveModelAlias(input.modelId.trim());
    if (!normalizedModel || !getProviderModelSet(account.provider).has(normalizedModel)) {
      return { success: false, error: `Model "${normalizedModel || input.modelId}" is not supported by provider "${account.provider}"` } as const;
    }

    const lookupKeys = getModelLookupKeys(normalizedModel);
    await db.delete(providerAccountDisabledModel).where(and(eq(providerAccountDisabledModel.providerAccountId, account.id), inArray(providerAccountDisabledModel.model, lookupKeys)));
    if (!input.enabled) await db.insert(providerAccountDisabledModel).values({ providerAccountId: account.id, model: normalizedModel }).onConflictDoNothing({ target: [providerAccountDisabledModel.providerAccountId, providerAccountDisabledModel.model] });

    await invalidateDisabledModelsCache(userId);
    return { success: true, data: { model: normalizedModel, enabled: input.enabled } } as const;
  } catch (error) {
    console.error("Failed to update account model status:", error);
    return { success: false, error: "Failed to update model status" } as const;
  }
}

export async function getAccountErrorHistory(userId: string, input: z.infer<typeof errorHistoryInputSchema>) {
    const [account] = await db.select({ id: providerAccount.id }).from(providerAccount).where(and(eq(providerAccount.id, input.accountId), eq(providerAccount.userId, userId))).limit(1);
    if (!account) return { success: false, error: "Account not found" } as const;

    const entries = await db
      .select({ id: providerAccountErrorHistory.id, model: providerAccountErrorHistory.model, errorCode: providerAccountErrorHistory.errorCode, errorMessage: providerAccountErrorHistory.errorMessage, createdAt: providerAccountErrorHistory.createdAt })
      .from(providerAccountErrorHistory)
      .where(eq(providerAccountErrorHistory.providerAccountId, input.accountId))
      .orderBy(desc(providerAccountErrorHistory.createdAt), desc(providerAccountErrorHistory.id))
      .limit(Math.min(input.limit ?? MAX_ERROR_HISTORY_ROWS, MAX_ERROR_HISTORY_ROWS));

    return { success: true, data: { entries } } as const;
}

export async function resolveAccountErrors(userId: string, input: z.infer<typeof resolveErrorsInputSchema>) {
  try {
    const [account] = await db.select({ id: providerAccount.id, status: providerAccount.status }).from(providerAccount).where(and(eq(providerAccount.id, input.accountId), eq(providerAccount.userId, userId))).limit(1);
    if (!account) return { success: false, error: "Account not found" } as const;

    await db
      .update(providerAccount)
      .set({
        errorCount: 0,
        consecutiveErrors: 0,
        lastErrorAt: null,
        lastErrorMessage: null,
        lastErrorCode: null,
        lastRecoveredByRotationAt: null,
        ...(account.status === "degraded" || account.status === "failed" ? { status: "active", statusChangedAt: new Date() } : {}),
      })
      .where(eq(providerAccount.id, input.accountId));
    await db.delete(providerAccountErrorHistory).where(eq(providerAccountErrorHistory.providerAccountId, input.accountId));
    await db.delete(providerAccountModelHealth).where(eq(providerAccountModelHealth.providerAccountId, input.accountId));
    return { success: true, data: undefined } as const;
  } catch (error) {
    console.error("Failed to resolve provider account errors:", error);
    return { success: false, error: "Failed to resolve account errors" } as const;
  }
}
