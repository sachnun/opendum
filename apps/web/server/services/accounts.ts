import { db, pinnedProvider, providerAccount, providerAccountDisabledModel, providerAccountModelHealth } from "@opendum/database";
import { getModelLookupKeys, getProviderModelSet, resolveModelAlias } from "~~/server/lib/proxy/models";
import { clearRefreshFailCount, invalidateDisabledModelsCache } from "~~/server/lib/proxy/auth";
import { decrypt } from "~~/server/lib/encryption";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { isKnownProvider, PROVIDER_ACCOUNT_KEYS } from "./account-providers.ts";
import { customProviderModels } from "./custom-providers.ts";
import { trackProviderEmail } from "./points.ts";
import { buildAccountStats, buildEmptyProviderStats, getProviderSummaryStats, type ProviderAccountIndicator } from "./account-stats.ts";
import {
  ACCOUNT_COOLDOWN_UNHEALTHY_THRESHOLD,
  type AccountHealthAggregate,
  type AccountModelHealthSummaryRow,
  type AccountOverviewSummary,
  type AccountReadOptions,
  accountHasActiveCooldown,
  accountTierCanAccessModel,
  buildAccountHealthByAccountId,
  buildAccountPingSummaries,
  buildStatsDelta,
  decodeAccountOverviewCursor,
  decodeProviderDetailCursor,
  deleteRedisErrorHistory,
  encodeAccountOverviewCursor,
  encodeProviderDetailCursor,
  getAccountSummaryHealthRows,
  getCooldownRecoveryAccountIds,
  getPinnedProviderKeys,
  getProviderModelsForAccountTier,
  hasActionableHealthWarning,
  hashAccountOverviewValue,
  providerModelIsAccessibleByAccounts,
  readRedisErrorHistories,
  readRedisErrorHistory,
  sortProviderModels,
  toTimeMs,
  withEffectiveActive,
  withEffectiveModelHealth,
} from "./accounts-helpers.ts";
export { getProviderModelsForAccountTier };

export { createAccount, createAccountInputSchema } from "./account-connectors.ts";

const ACCOUNT_COOLDOWN_MS = 10 * 60 * 1000;
const DEFAULT_ERROR_HISTORY_ROWS = 100;
const MAX_ERROR_HISTORY_ROWS = 200;

type AccountModelHealthRecoveryRow = AccountModelHealthSummaryRow & {
  id: string;
  updatedAt: Date | string | null;
  createdAt: Date | string | null;
};

interface AccountOverviewReadOptions extends AccountReadOptions {
  cursor?: string;
}

const PROVIDER_KEY_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
export const providerInputSchema = z.object({
  provider: z.string().trim().toLowerCase().regex(PROVIDER_KEY_PATTERN, "Invalid provider"),
});
const accountIdSchema = z.string().trim().min(1);
export const updateAccountInputSchema = z.object({ id: accountIdSchema, name: z.string().max(120).optional(), isActive: z.boolean().optional(), disabledUntil: z.coerce.date().nullable().optional() });
export const deleteAccountInputSchema = z.object({ id: accountIdSchema });
export const togglePinnedProviderInputSchema = z.object({ providerKey: z.string().trim().min(1) });
export const setAccountModelEnabledInputSchema = z.object({ accountId: accountIdSchema, modelId: z.string().trim().min(1), enabled: z.boolean() });
export const errorHistoryInputSchema = z.object({ accountId: accountIdSchema, limit: z.coerce.number().int().min(1).max(200).optional() });
export const errorHistoryBatchInputSchema = z.object({ accountIds: z.array(accountIdSchema).max(50), limit: z.coerce.number().int().min(1).max(200).optional() });
export const resolveErrorsInputSchema = z.object({ accountId: accountIdSchema });
export const accountSessionInputSchema = z.object({ id: accountIdSchema });
const statsIdsQuerySchema = z.preprocess((value) => (Array.isArray(value) ? value : value == null ? [] : [value]), z.array(z.string().min(1)).max(50));
const statsCursorsQuerySchema = z.preprocess((value) => (Array.isArray(value) ? value : value == null ? [] : [value]), z.array(z.string()).max(50)).optional();

export const accountStatsInputSchema = z.object({ ids: statsIdsQuerySchema, cursors: statsCursorsQuerySchema }).transform(({ ids, cursors }) => ({
  accountIds: ids,
  cursors: cursors ? Object.fromEntries(ids.map((id, index) => [id, cursors[index] ?? ""])) : undefined,
}));
export const accountOverviewInputSchema = z.object({ cursor: z.string().min(1).optional() });
export const providerDetailInputSchema = providerInputSchema.extend({ cursor: z.string().min(1).optional() });

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
  lastErrorCode: providerAccount.lastErrorCode,
  successCount: providerAccount.successCount,
  createdAt: providerAccount.createdAt,
};

const providerAccountLastUsedOrder = [sql`${providerAccount.lastUsedAt} desc nulls last`, desc(providerAccount.createdAt), desc(providerAccount.id)] as const;

export async function listAccounts(userId: string) {
  try {
    const now = new Date();
    const accounts = await db.select(providerAccountListColumns).from(providerAccount).where(eq(providerAccount.userId, userId)).orderBy(asc(providerAccount.createdAt));
    return accounts.map((account) => ({ ...withEffectiveActive(account, now), unhealthyCount: account.consecutiveErrors }));
  } catch (error) {
    console.error("Failed to list accounts:", error);
    throw new Error("Failed to list accounts", { cause: error });
  }
}

export async function listAccountsByProvider(userId: string, input: z.infer<typeof providerInputSchema>) {
  try {
    const now = new Date();
    const accounts = await db.select(providerAccountListColumns).from(providerAccount).where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, input.provider))).orderBy(...providerAccountLastUsedOrder);
    return accounts.map((account) => ({ ...withEffectiveActive(account, now), unhealthyCount: account.consecutiveErrors }));
  } catch (error) {
    console.error("Failed to list provider accounts:", error);
    throw new Error("Failed to list provider accounts", { cause: error });
  }
}

export async function getAccountOverview(userId: string, options: AccountOverviewReadOptions = {}) {
  try {
    const now = new Date();
    const [accounts, providerStats] = await Promise.all([
      db
        .select({
          id: providerAccount.id,
          provider: providerAccount.provider,
          isActive: providerAccount.isActive,
          disabledUntil: providerAccount.disabledUntil,
          status: providerAccount.status,
          statusChangedAt: providerAccount.statusChangedAt,
          consecutiveErrors: providerAccount.consecutiveErrors,
          lastUsedAt: providerAccount.lastUsedAt,
          lastErrorAt: providerAccount.lastErrorAt,
          lastErrorCode: providerAccount.lastErrorCode,
          lastSuccessAt: providerAccount.lastSuccessAt,
          lastRecoveredByRotationAt: providerAccount.lastRecoveredByRotationAt,
        })
        .from(providerAccount)
        .where(eq(providerAccount.userId, userId)),
      getProviderSummaryStats(userId),
    ]);
    const [pinnedProviders, healthRows] = await Promise.all([
      getPinnedProviderKeys(userId, accounts.map((account) => account.provider), options),
      getAccountSummaryHealthRows(accounts.map((account) => account.id)),
    ]);

    const pingSummaries = buildAccountPingSummaries(accounts, buildAccountHealthByAccountId(healthRows, now, getCooldownRecoveryAccountIds(accounts, now)), now);

    const providerKeys = Array.from(new Set<string>([...PROVIDER_ACCOUNT_KEYS, ...accounts.map((account) => account.provider)]));
    const summaries = Object.fromEntries(
      providerKeys.map((provider) => [
        provider,
        {
          ...(pingSummaries[provider] ?? { connected: 0, active: 0, indicator: "normal" as ProviderAccountIndicator }),
          stats: providerStats[provider] ?? buildEmptyProviderStats(),
        },
      ])
    ) as Record<string, AccountOverviewSummary>;
    const cursor = encodeAccountOverviewCursor(pinnedProviders, summaries);
    const previousCursor = decodeAccountOverviewCursor(options.cursor);

    if (previousCursor) {
      const summariesChanged = previousCursor.summaries !== hashAccountOverviewValue(summaries);
      const pinnedChanged = previousCursor.pinned !== hashAccountOverviewValue(pinnedProviders);

      return {
        delta: true,
        cursor,
        ...(summariesChanged ? { summaries } : {}),
        ...(pinnedChanged ? { pinnedProviders } : {}),
      };
    }

    return { summaries, pinnedProviders, cursor };
  } catch (error) {
    console.error("Failed to load account summaries:", error);
    throw new Error("Failed to load account summaries", { cause: error });
  }
}

export async function getAccountPing(userId: string, options: AccountReadOptions = {}) {
  try {
    const now = new Date();
    const accounts = await db
      .select({
        id: providerAccount.id,
        provider: providerAccount.provider,
        isActive: providerAccount.isActive,
        disabledUntil: providerAccount.disabledUntil,
        status: providerAccount.status,
        statusChangedAt: providerAccount.statusChangedAt,
        consecutiveErrors: providerAccount.consecutiveErrors,
        lastUsedAt: providerAccount.lastUsedAt,
        lastErrorAt: providerAccount.lastErrorAt,
        lastErrorCode: providerAccount.lastErrorCode,
        lastSuccessAt: providerAccount.lastSuccessAt,
        lastRecoveredByRotationAt: providerAccount.lastRecoveredByRotationAt,
      })
      .from(providerAccount)
      .where(eq(providerAccount.userId, userId));
    const [pinnedProviders, healthRows] = await Promise.all([
      getPinnedProviderKeys(userId, accounts.map((account) => account.provider), options),
      getAccountSummaryHealthRows(accounts.map((account) => account.id)),
    ]);

    const pingSummaries = buildAccountPingSummaries(accounts, buildAccountHealthByAccountId(healthRows, now, getCooldownRecoveryAccountIds(accounts, now)), now);

    return {
      summaries: Object.fromEntries(pinnedProviders.map((provider) => [provider, pingSummaries[provider]])),
      pinnedProviders,
      hasConnectedAccounts: accounts.length > 0,
    };
  } catch (error) {
    console.error("Failed to ping account summaries:", error);
    throw new Error("Failed to ping account summaries", { cause: error });
  }
}

export async function getAccountsByProviderDetailed(userId: string, input: z.infer<typeof providerDetailInputSchema>) {
  try {
    const now = new Date();
    const accounts = await db
      .select(providerAccountListColumns)
      .from(providerAccount)
      .where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, input.provider)))
      .orderBy(...providerAccountLastUsedOrder);

    const accountIds = accounts.map((account) => account.id);
    const isBuiltin = isKnownProvider(input.provider);
    const customModels = isBuiltin ? [] : await customProviderModels(userId, input.provider);
    const providerModels = isBuiltin ? Array.from(getProviderModelSet(input.provider)) : customModels;
    const supportedModelsByAccountId = Object.fromEntries(accounts.map((account) => [
      account.id,
      isBuiltin ? getProviderModelsForAccountTier(input.provider, account.tier) : customModels,
    ]));
    const supportedModels = sortProviderModels(
      isBuiltin
        ? providerModels.filter((model) =>
            input.provider === "codex"
              ? true
              : providerModelIsAccessibleByAccounts(model, input.provider, accounts)
          )
        : providerModels
    );
    const freeSupportedModels = isBuiltin ? getProviderModelsForAccountTier(input.provider, "free") : customModels;
    const healthModelKeys = Array.from(new Set(supportedModels.flatMap((model) => getModelLookupKeys(model))));
    const [disabledModelRows, healthRows, pinnedProviders] = await Promise.all([
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
              lastErrorCode: providerAccountModelHealth.lastErrorCode,
              lastSuccessAt: providerAccountModelHealth.lastSuccessAt,
              unhealthyCountUpdatedAt: providerAccountModelHealth.unhealthyCountUpdatedAt,
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

    const cooldownRecoveryAccountIds = getCooldownRecoveryAccountIds(accounts, now);
    const effectiveHealthRows = healthRows.map((row) => withEffectiveModelHealth(row, now, cooldownRecoveryAccountIds.has(row.providerAccountId)));
    const healthByAccountId = effectiveHealthRows.reduce<Record<string, AccountHealthAggregate>>((acc, row) => {
      const current = acc[row.providerAccountId] ?? { unhealthyCount: 0, warningCount: 0, lastErrorAt: null, lastSuccessAt: null };
      current.unhealthyCount += row.consecutiveErrors;
      if (hasActionableHealthWarning(row)) current.warningCount += row.consecutiveErrors;
      if ((toTimeMs(row.lastErrorAt) ?? 0) > (toTimeMs(current.lastErrorAt) ?? 0)) current.lastErrorAt = row.lastErrorAt;
      if ((toTimeMs(row.lastSuccessAt) ?? 0) > (toTimeMs(current.lastSuccessAt) ?? 0)) current.lastSuccessAt = row.lastSuccessAt;
      acc[row.providerAccountId] = current;
      return acc;
    }, {});
    const modelHealthByAccountId = effectiveHealthRows.reduce<Record<string, Record<string, { status: string; consecutiveErrors: number; lastErrorAt: Date | string | null; lastSuccessAt: Date | string | null }>>>((acc, row) => {
      const model = resolveModelAlias(row.model);
      const accountHealth = acc[row.providerAccountId] ?? {};
      const current = accountHealth[model];
      if (!current || row.consecutiveErrors > current.consecutiveErrors) {
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

    const detailedAccounts = accounts.map((account) => {
      const health = healthByAccountId[account.id];
      const unhealthyCount = health?.unhealthyCount ?? account.consecutiveErrors;
      const status = accountHasActiveCooldown(account, now) || unhealthyCount >= ACCOUNT_COOLDOWN_UNHEALTHY_THRESHOLD ? "failed" : "active";

      return {
        ...withEffectiveActive(account, now),
        status,
        consecutiveErrors: unhealthyCount,
        unhealthyCount,
        lastErrorAt: health?.lastErrorAt ?? account.lastErrorAt,
        lastSuccessAt: health?.lastSuccessAt ?? account.lastSuccessAt,
        stats: buildEmptyProviderStats(),
      };
    });

    const detail = {
      accounts: detailedAccounts,
      supportedModels,
      freeSupportedModels,
      supportedModelsByAccountId,
      disabledModelsByAccountId,
      modelHealthByAccountId,
      pinnedProviders,
    };
    const cursor = encodeProviderDetailCursor(detail);
    const previousCursor = decodeProviderDetailCursor(input.cursor);

    if (previousCursor) {
      const changedAccounts = detail.accounts.filter((account) => previousCursor.accounts[account.id] !== hashAccountOverviewValue(account));
      const currentAccountIds = new Set(detail.accounts.map((account) => account.id));
      const deletedAccountIds = Object.keys(previousCursor.accounts).filter((accountId) => !currentAccountIds.has(accountId));
      const changedSupportedModels = Object.fromEntries(Object.entries(detail.supportedModelsByAccountId).filter(([accountId, models]) => previousCursor.supportedModelsByAccountId[accountId] !== hashAccountOverviewValue(models)));
      const clearedSupportedModelsByAccountId = Object.keys(previousCursor.supportedModelsByAccountId).filter((accountId) => !(accountId in detail.supportedModelsByAccountId));
      const changedDisabledModels = Object.fromEntries(Object.entries(detail.disabledModelsByAccountId).filter(([accountId, models]) => previousCursor.disabledModelsByAccountId[accountId] !== hashAccountOverviewValue(models)));
      const clearedDisabledModelsByAccountId = Object.keys(previousCursor.disabledModelsByAccountId).filter((accountId) => !(accountId in detail.disabledModelsByAccountId));
      const changedModelHealth = Object.fromEntries(Object.entries(detail.modelHealthByAccountId).filter(([accountId, health]) => previousCursor.modelHealthByAccountId[accountId] !== hashAccountOverviewValue(health)));
      const clearedModelHealthByAccountId = Object.keys(previousCursor.modelHealthByAccountId).filter((accountId) => !(accountId in detail.modelHealthByAccountId));

      return {
        delta: true,
        cursor,
        ...(changedAccounts.length > 0 ? { accounts: changedAccounts } : {}),
        ...(deletedAccountIds.length > 0 ? { deletedAccountIds } : {}),
        ...(previousCursor.supportedModels !== hashAccountOverviewValue(detail.supportedModels) ? { supportedModels: detail.supportedModels } : {}),
        ...(previousCursor.freeSupportedModels !== hashAccountOverviewValue(detail.freeSupportedModels) ? { freeSupportedModels: detail.freeSupportedModels } : {}),
        ...(Object.keys(changedSupportedModels).length > 0 ? { supportedModelsByAccountId: changedSupportedModels } : {}),
        ...(clearedSupportedModelsByAccountId.length > 0 ? { clearedSupportedModelsByAccountId } : {}),
        ...(Object.keys(changedDisabledModels).length > 0 ? { disabledModelsByAccountId: changedDisabledModels } : {}),
        ...(clearedDisabledModelsByAccountId.length > 0 ? { clearedDisabledModelsByAccountId } : {}),
        ...(Object.keys(changedModelHealth).length > 0 ? { modelHealthByAccountId: changedModelHealth } : {}),
        ...(clearedModelHealthByAccountId.length > 0 ? { clearedModelHealthByAccountId } : {}),
        ...(previousCursor.pinnedProviders !== hashAccountOverviewValue(detail.pinnedProviders) ? { pinnedProviders: detail.pinnedProviders } : {}),
      };
    }

    return { ...detail, cursor };
  } catch (error) {
    console.error("Failed to load provider account detail:", error);
    throw new Error("Failed to load provider account detail", { cause: error });
  }
}

export async function getAccountStats(userId: string, input: z.infer<typeof accountStatsInputSchema>) {
  try {
    const accountIds = Array.from(new Set(input.accountIds));
    if (accountIds.length === 0) return {};

    const ownedAccounts = await db
      .select({ id: providerAccount.id })
      .from(providerAccount)
      .where(and(eq(providerAccount.userId, userId), inArray(providerAccount.id, accountIds)));
    const ownedAccountIds = ownedAccounts.map((account) => account.id);
    return buildStatsDelta(await buildAccountStats(userId, ownedAccountIds), input.cursors);
  } catch (error) {
    console.error("Failed to load account stats:", error);
    throw new Error("Failed to load account stats", { cause: error });
  }
}

export async function updateAccount(userId: string, input: z.infer<typeof updateAccountInputSchema>) {
    try {
      const [account] = await db.select({ id: providerAccount.id, status: providerAccount.status }).from(providerAccount).where(and(eq(providerAccount.id, input.id), eq(providerAccount.userId, userId))).limit(1);
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
        if (manuallyReenabled) await clearRefreshFailCount(input.id);
        if (manuallyReenabled && account.status === "failed") await accelerateAccountCooldownForManualEnable(input.id, now);
        if (updates.isActive !== undefined || updates.disabledUntil !== undefined) await invalidateDisabledModelsCache(userId);
      }

      const [updated] = await db
        .select({ id: providerAccount.id, name: providerAccount.name, isActive: providerAccount.isActive, disabledUntil: providerAccount.disabledUntil, status: providerAccount.status, statusChangedAt: providerAccount.statusChangedAt, consecutiveErrors: providerAccount.consecutiveErrors })
        .from(providerAccount)
        .where(eq(providerAccount.id, input.id))
        .limit(1);
      if (!updated) return { success: false, error: "Account not found" } as const;

      return { success: true, data: { ...withEffectiveActive(updated, now), unhealthyCount: updated.consecutiveErrors } } as const;
    } catch (error) {
      console.error("Failed to update account:", error);
      return { success: false, error: "Failed to update account" } as const;
    }
}

async function accelerateAccountCooldownForManualEnable(accountId: string, now = new Date()): Promise<void> {
  await db.transaction(async (tx) => {
    const rows: AccountModelHealthRecoveryRow[] = await tx
      .select({
        id: providerAccountModelHealth.id,
        providerAccountId: providerAccountModelHealth.providerAccountId,
        status: providerAccountModelHealth.status,
        statusChangedAt: providerAccountModelHealth.statusChangedAt,
        consecutiveErrors: providerAccountModelHealth.consecutiveErrors,
        lastErrorAt: providerAccountModelHealth.lastErrorAt,
        lastErrorCode: providerAccountModelHealth.lastErrorCode,
        lastSuccessAt: providerAccountModelHealth.lastSuccessAt,
        unhealthyCountUpdatedAt: providerAccountModelHealth.unhealthyCountUpdatedAt,
        updatedAt: providerAccountModelHealth.updatedAt,
        createdAt: providerAccountModelHealth.createdAt,
      })
      .from(providerAccountModelHealth)
      .where(eq(providerAccountModelHealth.providerAccountId, accountId));

    let total = 0;
    for (const row of rows) {
      const recovered = withEffectiveModelHealth(row, now, true);
      total += recovered.consecutiveErrors;
      const patch: { consecutiveErrors: number; unhealthyCountUpdatedAt: Date; status?: string; statusChangedAt?: Date } = {
        consecutiveErrors: recovered.consecutiveErrors,
        unhealthyCountUpdatedAt: now,
      };
      if (row.status === "failed" || recovered.status !== row.status) {
        patch.status = recovered.status;
        patch.statusChangedAt = now;
      }
      await tx.update(providerAccountModelHealth).set(patch).where(eq(providerAccountModelHealth.id, row.id));
    }

    const stillCoolingDown = total >= ACCOUNT_COOLDOWN_UNHEALTHY_THRESHOLD;
    await tx
      .update(providerAccount)
      .set({
        status: stillCoolingDown ? "failed" : "active",
        statusChangedAt: now,
        consecutiveErrors: total,
        disabledUntil: stillCoolingDown ? new Date(now.getTime() + ACCOUNT_COOLDOWN_MS) : null,
      })
      .where(eq(providerAccount.id, accountId));
  });
}

export async function deleteAccount(userId: string, input: z.infer<typeof deleteAccountInputSchema>) {
  try {
    const [account] = await db.select({ id: providerAccount.id, email: providerAccount.email }).from(providerAccount).where(and(eq(providerAccount.id, input.id), eq(providerAccount.userId, userId))).limit(1);
    if (!account) return { success: false, error: "Account not found" } as const;

    if (account.email) await trackProviderEmail(userId, account.email);
    await db.delete(providerAccount).where(eq(providerAccount.id, input.id));
    await invalidateDisabledModelsCache(userId);
    await clearRefreshFailCount(input.id);
    return { success: true, data: undefined } as const;
  } catch (error) {
    console.error("Failed to delete account:", error);
    return { success: false, error: "Failed to delete account" } as const;
  }
}

export async function togglePinnedProvider(userId: string, input: z.infer<typeof togglePinnedProviderInputSchema>) {
  if (!PROVIDER_KEY_PATTERN.test(input.providerKey)) return { success: false, error: "Invalid provider" } as const;

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
      .select({ id: providerAccount.id, provider: providerAccount.provider, tier: providerAccount.tier })
      .from(providerAccount)
      .where(and(eq(providerAccount.id, input.accountId), eq(providerAccount.userId, userId)))
      .limit(1);
    if (!account) return { success: false, error: "Account not found" } as const;

    const normalizedModel = resolveModelAlias(input.modelId.trim());
    if (!normalizedModel || !getProviderModelSet(account.provider).has(normalizedModel)) {
      return { success: false, error: `Model "${normalizedModel || input.modelId}" is not supported by provider "${account.provider}"` } as const;
    }
    if (!accountTierCanAccessModel(account.tier, normalizedModel, account.provider)) {
      return { success: false, error: `Model "${normalizedModel}" is not available for this account tier` } as const;
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
  try {
    const [account] = await db.select({ id: providerAccount.id }).from(providerAccount).where(and(eq(providerAccount.id, input.accountId), eq(providerAccount.userId, userId))).limit(1);
    if (!account) return { success: false, error: "Account not found" } as const;

    const entries = await readRedisErrorHistory(input.accountId, Math.min(input.limit ?? DEFAULT_ERROR_HISTORY_ROWS, MAX_ERROR_HISTORY_ROWS));

    return { success: true, data: { entries } } as const;
  } catch (error) {
    console.error("Failed to read provider account error history:", error);
    return { success: true, data: { entries: [] } } as const;
  }
}

export async function getAccountErrorHistories(userId: string, input: z.infer<typeof errorHistoryBatchInputSchema>) {
  const accountIds = Array.from(new Set(input.accountIds));
  if (accountIds.length === 0) return { success: true, data: {} } as const;

  try {
    const ownedAccounts = await db
      .select({ id: providerAccount.id })
      .from(providerAccount)
      .where(and(eq(providerAccount.userId, userId), inArray(providerAccount.id, accountIds)));
    const ownedAccountIds = ownedAccounts.map((account) => account.id);
    const entriesByAccountId = await readRedisErrorHistories(ownedAccountIds, Math.min(input.limit ?? DEFAULT_ERROR_HISTORY_ROWS, MAX_ERROR_HISTORY_ROWS));
    const results = Object.fromEntries(accountIds.map((accountId) => {
      if (!entriesByAccountId[accountId]) return [accountId, { success: false, error: "Account not found" }];
      return [accountId, { success: true, data: { entries: entriesByAccountId[accountId] } }];
    }));

    return { success: true, data: results } as const;
  } catch (error) {
    console.error("Failed to read provider account error histories:", error);
    return { success: true, data: Object.fromEntries(accountIds.map((accountId) => [accountId, { success: true, data: { entries: [] } }])) } as const;
  }
}

export async function getAccountSession(userId: string, input: z.infer<typeof accountSessionInputSchema>) {
  try {
    const [account] = await db
      .select({ accessToken: providerAccount.accessToken, refreshToken: providerAccount.refreshToken, apiKey: providerAccount.apiKey, accountId: providerAccount.accountId, provider: providerAccount.provider, email: providerAccount.email })
      .from(providerAccount)
      .where(and(eq(providerAccount.id, input.id), eq(providerAccount.userId, userId)))
      .limit(1);
    if (!account) return { success: false, error: "Account not found" } as const;

    const session = decrypt(account.accessToken);
    return { success: true, data: { session } } as const;
  } catch (error) {
    console.error("Failed to read account session:", error);
    return { success: false, error: "Failed to read account session" } as const;
  }
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
        lastErrorCode: null,
        lastRecoveredByRotationAt: null,
        ...(account.status === "failed" ? { status: "active", statusChangedAt: new Date(), disabledUntil: null } : {}),
      })
      .where(eq(providerAccount.id, input.accountId));
    await deleteRedisErrorHistory(input.accountId);
    await db.delete(providerAccountModelHealth).where(eq(providerAccountModelHealth.providerAccountId, input.accountId));
    await clearRefreshFailCount(input.accountId);
    return { success: true, data: undefined } as const;
  } catch (error) {
    console.error("Failed to resolve provider account errors:", error);
    return { success: false, error: "Failed to resolve account errors" } as const;
  }
}
