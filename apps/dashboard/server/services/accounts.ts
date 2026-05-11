import { db } from "../lib/db";
import { pinnedProvider, providerAccount, providerAccountDisabledModel, providerAccountErrorHistory, providerAccountModelHealth } from "../lib/db/schema";
import { getModelLookupKeys, getProviderModelSet, resolveModelAlias } from "../lib/proxy/models";
import { invalidateDisabledModelsCache } from "../lib/proxy/auth";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { isKnownProvider, PROVIDER_ACCOUNT_KEYS, type ProviderAccountKey } from "./account-providers";
import { buildAccountStats, getAccountIndicator, getProviderSummaryStats, INDICATOR_WEIGHT, type ProviderAccountIndicator, type ProviderStats } from "./account-stats";

export { exchangeOAuthAccount, exchangeOAuthInputSchema, getAccountAuthUrl, getAuthUrlInputSchema, initiateDeviceAuth, initiateDeviceAuthInputSchema, pollDeviceAuth, pollDeviceAuthInputSchema } from "./account-auth";
export { createAccount, createAccountInputSchema } from "./account-connectors";

const AUTO_PIN_SENTINEL = "_auto_pinned";
const ACCOUNT_HEALTH_STATUS_WEIGHT: Record<string, number> = { active: 0, degraded: 1, half_open: 2, failed: 3 };

export const providerInputSchema = z.object({ provider: z.string() });
export const updateAccountInputSchema = z.object({ id: z.string(), name: z.string().optional(), isActive: z.boolean().optional(), disabledUntil: z.coerce.date().nullable().optional() });
export const deleteAccountInputSchema = z.object({ id: z.string() });
export const togglePinnedProviderInputSchema = z.object({ providerKey: z.string() });
export const setAccountModelEnabledInputSchema = z.object({ accountId: z.string(), modelId: z.string(), enabled: z.boolean() });
export const errorHistoryInputSchema = z.object({ accountId: z.string(), limit: z.number().int().min(1).max(200).optional() });
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
  statusReason: providerAccount.statusReason,
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

export async function getAccountSummary(userId: string) {
  try {
    const [accounts, providerStats] = await Promise.all([
      db
        .select({
          provider: providerAccount.provider,
          isActive: providerAccount.isActive,
          disabledUntil: providerAccount.disabledUntil,
          lastErrorAt: providerAccount.lastErrorAt,
          lastSuccessAt: providerAccount.lastSuccessAt,
          lastRecoveredByRotationAt: providerAccount.lastRecoveredByRotationAt,
        })
        .from(providerAccount)
        .where(eq(providerAccount.userId, userId)),
      getProviderSummaryStats(userId),
    ]);
    const pinnedProviders = await getPinnedProviderKeys(userId, accounts.map((account) => account.provider));

    const summaries = Object.fromEntries(
      PROVIDER_ACCOUNT_KEYS.map((provider) => [
        provider,
        {
          connected: 0,
          active: 0,
          indicator: "normal" as ProviderAccountIndicator,
          stats: providerStats[provider],
        },
      ])
    ) as Record<ProviderAccountKey, { connected: number; active: number; indicator: ProviderAccountIndicator; stats: ProviderStats }>;

    for (const account of accounts) {
      if (!isKnownProvider(account.provider)) continue;

      const summary = summaries[account.provider];
      summary.connected += 1;

      if (!accountIsEffectivelyActive(account)) continue;

      summary.active += 1;
      const indicator = getAccountIndicator(account.lastErrorAt, account.lastSuccessAt, account.lastRecoveredByRotationAt);
      if (INDICATOR_WEIGHT[indicator] > INDICATOR_WEIGHT[summary.indicator]) {
        summary.indicator = indicator;
      }
    }

    return { summaries, pinnedProviders };
  } catch (error) {
    console.error("Failed to load account summaries:", error);
    throw new Error("Failed to load account summaries");
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
    const supportedModels = Array.from(getProviderModelSet(input.provider)).sort((a, b) => a.localeCompare(b));
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
              status: providerAccountModelHealth.status,
              statusReason: providerAccountModelHealth.statusReason,
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

    const healthByAccountId = healthRows.reduce<Record<string, (typeof healthRows)[number]>>((acc, row) => {
      const current = acc[row.providerAccountId];
      const currentWeight = current ? ACCOUNT_HEALTH_STATUS_WEIGHT[current.status] ?? 0 : 0;
      const nextWeight = ACCOUNT_HEALTH_STATUS_WEIGHT[row.status] ?? 0;
      if (nextWeight > currentWeight || (nextWeight === currentWeight && row.consecutiveErrors > (current?.consecutiveErrors ?? 0))) {
        acc[row.providerAccountId] = row;
      }
      return acc;
    }, {});

    return {
      accounts: accounts.map((account) => {
        const health = healthByAccountId[account.id];
        const accountWeight = ACCOUNT_HEALTH_STATUS_WEIGHT[account.status] ?? 0;
        const healthWeight = health ? ACCOUNT_HEALTH_STATUS_WEIGHT[health.status] ?? 0 : 0;
        const useModelHealth = health && (healthWeight > accountWeight || (healthWeight === accountWeight && health.consecutiveErrors > account.consecutiveErrors));

        return {
          ...withEffectiveActive(account, now),
          ...(useModelHealth
            ? {
                status: health.status,
                statusReason: health.statusReason,
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
      if (input.name !== undefined) {
        const name = input.name.trim();
        if (!name) return { success: false, error: "Please enter a name" } as const;
        updates.name = name;
      }

      if (input.disabledUntil instanceof Date) {
        if (input.disabledUntil <= new Date()) return { success: false, error: "Please choose a future time" } as const;
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
        if (updates.isActive !== undefined || updates.disabledUntil !== undefined) await invalidateDisabledModelsCache(userId);
      }

      return { success: true, data: undefined } as const;
    } catch (error) {
      console.error("Failed to update account:", error);
      return { success: false, error: "Failed to update account" } as const;
    }
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
      .select({ id: providerAccountErrorHistory.id, errorCode: providerAccountErrorHistory.errorCode, errorMessage: providerAccountErrorHistory.errorMessage, createdAt: providerAccountErrorHistory.createdAt })
      .from(providerAccountErrorHistory)
      .where(eq(providerAccountErrorHistory.providerAccountId, input.accountId))
      .orderBy(desc(providerAccountErrorHistory.createdAt), desc(providerAccountErrorHistory.id))
      .limit(input.limit ?? 200);

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
        ...(account.status === "degraded" || account.status === "failed" ? { status: "active", statusReason: null, statusChangedAt: new Date() } : {}),
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
