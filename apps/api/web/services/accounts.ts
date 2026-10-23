import { Effect } from "effect";
import { db, pinnedProvider, providerAccount, providerAccountDisabledModel, providerAccountModelHealth } from "@opendum/database";
import { fromPromise } from "#web/lib/task.js";
import { internal } from "#web/errors.js";
import type { AccountSessionInput, AccountStatsInput, DeleteAccountInput, ErrorHistoryBatchInput, ErrorHistoryInput, ProviderDetailInput, ProviderInput, ResolveErrorsInput, SetAccountModelEnabledInput, TogglePinnedProviderInput, UpdateAccountInput } from "@opendum/providers/contract";
import { publishAccountsChanged } from "#web/events/bus.js";
import { getModelLookupKeys, getProviderModelSet, resolveModelAlias } from "#web/lib/proxy/models.js";
import { clearRefreshFailCount, invalidateDisabledModelsCache } from "#web/lib/proxy/auth.js";
import { decrypt } from "#web/lib/encryption.js";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { isKnownProvider, PROVIDER_ACCOUNT_KEYS } from "./account-providers.js";
import { customProviderModels } from "./custom-providers.js";
import { trackProviderEmail } from "./points.js";
import { buildAccountStats, buildEmptyProviderStats, getProviderSummaryStats, type ProviderAccountIndicator, type ProviderStats } from "./account-stats.js";
import {
  UNHEALTHY_THRESHOLD,
  type AccountHealthAggregate,
  type AccountModelHealthSummaryRow,
  type AccountOverviewSummary,
  type AccountReadOptions,
  accountHasActiveCooldown,
  accountTierCanAccessModel,
  buildAccountHealthByAccountId,
  buildAccountPingSummaries,
  deleteRedisErrorHistory,
  getAccountSummaryHealthRows,
  getCooldownRecoveryAccountIds,
  getPinnedProviderKeys,
  getProviderModelsForAccountTier,
  hasActionableHealthWarning,
  providerModelIsAccessibleByAccounts,
  readRedisErrorHistories,
  readRedisErrorHistory,
  sortProviderModels,
  toTimeMs,
  withEffectiveActive,
  withEffectiveModelHealth,
} from "./accounts-helpers.js";
export { getProviderModelsForAccountTier };

export { createAccount } from "./account-connectors.js";

const ACCOUNT_COOLDOWN_MS = 10 * 60 * 1000;
const DEFAULT_ERROR_HISTORY_ROWS = 100;
const MAX_ERROR_HISTORY_ROWS = 200;

type AccountModelHealthRecoveryRow = AccountModelHealthSummaryRow & {
  id: string;
  updatedAt: Date | string | null;
  createdAt: Date | string | null;
};

interface AccountOverviewReadOptions extends AccountReadOptions {}

const PROVIDER_KEY_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
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

export const listAccounts = Effect.fn("accounts.list")(function* (userId: string) {
  return yield* listAccountsInner(userId).pipe(
    Effect.mapError((failure) => internal("Failed to list accounts", failure.cause ?? failure))
  );
});

const listAccountsInner = Effect.fnUntraced(function* (userId: string) {
  const now = new Date();
  const accounts = yield* fromPromise(
    () =>
      db
        .select(providerAccountListColumns)
        .from(providerAccount)
        .where(eq(providerAccount.userId, userId))
        .orderBy(asc(providerAccount.createdAt)),
    "Failed to list accounts"
  );
  return accounts.map((account) => ({
    ...withEffectiveActive(account, now),
    unhealthyCount: account.consecutiveErrors,
  }));
});

export const listAccountsByProvider = Effect.fn("accounts.listByProvider")(function* (
  userId: string,
  input: ProviderInput
) {
  return yield* listAccountsByProviderInner(userId, input).pipe(
    Effect.mapError((failure) => internal("Failed to list provider accounts", failure.cause ?? failure))
  );
});

const listAccountsByProviderInner = Effect.fnUntraced(function* (
  userId: string,
  input: ProviderInput
) {
  const now = new Date();
  const accounts = yield* fromPromise(
    () =>
      db
        .select(providerAccountListColumns)
        .from(providerAccount)
        .where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, input.provider)))
        .orderBy(...providerAccountLastUsedOrder),
    "Failed to list provider accounts"
  );
  return accounts.map((account) => ({
    ...withEffectiveActive(account, now),
    unhealthyCount: account.consecutiveErrors,
  }));
});

export const getAccountOverview = Effect.fn("accounts.overview")(function* (
  userId: string,
  options: AccountOverviewReadOptions = {}
) {
  return yield* buildAccountOverview(userId, options).pipe(
    Effect.mapError((failure) => internal("Failed to load account summaries", failure.cause ?? failure))
  );
});

const buildAccountOverview = Effect.fnUntraced(function* (
  userId: string,
  options: AccountOverviewReadOptions = {}
) {
  {
    const now = new Date();
    const [accounts, providerStats] = yield* Effect.all([
      fromPromise(
        () =>
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
        "Failed to load accounts"
      ),
      getProviderSummaryStats(userId),
    ], { concurrency: "unbounded" });
    const [pinnedProviders, healthRows] = yield* Effect.all([
      getPinnedProviderKeys(userId, accounts.map((account) => account.provider), options),
      getAccountSummaryHealthRows(accounts.map((account) => account.id)),
    ], { concurrency: "unbounded" });

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

    return { summaries, pinnedProviders };
  }
});

export const getAccountPing = Effect.fn("accounts.ping")(function* (
  userId: string,
  options: AccountReadOptions = {}
) {
  return yield* buildAccountPing(userId, options).pipe(
    Effect.mapError((failure) => internal("Failed to ping account summaries", failure.cause ?? failure))
  );
});

const buildAccountPing = Effect.fnUntraced(function* (
  userId: string,
  options: AccountReadOptions = {}
) {
  {
    const now = new Date();
    const accounts = yield* fromPromise(() => db
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
      .where(eq(providerAccount.userId, userId)), "Failed to load accounts");
    const [pinnedProviders, healthRows] = yield* Effect.all([
      getPinnedProviderKeys(userId, accounts.map((account) => account.provider), options),
      getAccountSummaryHealthRows(accounts.map((account) => account.id)),
    ], { concurrency: "unbounded" });

    const pingSummaries = buildAccountPingSummaries(accounts, buildAccountHealthByAccountId(healthRows, now, getCooldownRecoveryAccountIds(accounts, now)), now);

    return {
      summaries: Object.fromEntries(pinnedProviders.map((provider) => [provider, pingSummaries[provider]])),
      pinnedProviders,
      hasConnectedAccounts: accounts.length > 0,
    };
  }
});

export const getAccountsByProviderDetailed = Effect.fn("accounts.detail")(function* (
  userId: string,
  input: ProviderDetailInput
) {
  return yield* buildAccountDetail(userId, input).pipe(
    Effect.mapError((failure: { cause?: unknown }) =>
      internal("Failed to load provider account detail", failure.cause ?? failure)
    )
  );
});

const buildAccountDetail = Effect.fnUntraced(function* (
  userId: string,
  input: ProviderDetailInput
) {
  {
    const now = new Date();
    const accounts = yield* fromPromise(() => db
      .select(providerAccountListColumns)
      .from(providerAccount)
      .where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, input.provider)))
      .orderBy(...providerAccountLastUsedOrder), "Failed to load provider accounts");

    const accountIds = accounts.map((account) => account.id);
    const isBuiltin = isKnownProvider(input.provider);
    const customModels = isBuiltin ? [] : yield* customProviderModels(userId, input.provider);
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
    const [disabledModelRows, healthRows, pinnedProviders] = yield* Effect.all([
      accountIds.length > 0
        ? fromPromise(
            () =>
              db
                .select({ providerAccountId: providerAccountDisabledModel.providerAccountId, model: providerAccountDisabledModel.model })
                .from(providerAccountDisabledModel)
                .where(inArray(providerAccountDisabledModel.providerAccountId, accountIds)),
            "Failed to load disabled account models"
          )
        : Effect.succeed([]),
      accountIds.length > 0 && healthModelKeys.length > 0
        ? fromPromise(() => db
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
            .where(and(inArray(providerAccountModelHealth.providerAccountId, accountIds), inArray(providerAccountModelHealth.model, healthModelKeys))), "Failed to load account model health")
        : Effect.succeed([]),
      getPinnedProviderKeys(userId),
    ], { concurrency: "unbounded" });

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
      const status = accountHasActiveCooldown(account, now) || unhealthyCount >= UNHEALTHY_THRESHOLD ? "failed" : "active";

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

    return {
      accounts: detailedAccounts,
      supportedModels,
      freeSupportedModels,
      supportedModelsByAccountId,
      disabledModelsByAccountId,
      modelHealthByAccountId,
      pinnedProviders,
    };
  }
});

export const getAccountStats = Effect.fn("accounts.stats")(function* (
  userId: string,
  input: AccountStatsInput
) {
  const accountIds = Array.from(new Set(input.accountIds));
  if (accountIds.length === 0) return {} as Record<string, ProviderStats>;

  const ownedAccounts = yield* fromPromise(
    () =>
      db
        .select({ id: providerAccount.id })
        .from(providerAccount)
        .where(and(eq(providerAccount.userId, userId), inArray(providerAccount.id, accountIds))),
    "Failed to load account stats"
  );
  const ownedAccountIds = ownedAccounts.map((account) => account.id);
  return yield* buildAccountStats(userId, ownedAccountIds).pipe(
    Effect.mapError((failure) => internal("Failed to load account stats", failure.cause ?? failure))
  );
});

const failWith = (message: string) => Effect.succeed({ success: false as const, error: message });

export const updateAccount = Effect.fn("accounts.update")(function* (
  userId: string,
  input: UpdateAccountInput
) {
  return yield* updateAccountInner(userId, input).pipe(
    Effect.catch((failure: { message: string }) => failWith(failure.message))
  );
});

const updateAccountInner = Effect.fnUntraced(function* (
  userId: string,
  input: UpdateAccountInput
) {
  const accountRows = yield* fromPromise(
    () =>
      db
        .select({ id: providerAccount.id, status: providerAccount.status })
        .from(providerAccount)
        .where(and(eq(providerAccount.id, input.id), eq(providerAccount.userId, userId)))
        .limit(1),
    "Failed to load account"
  );
  const account = accountRows[0];
  if (!account) return yield* Effect.fail(internal("Account not found"));

  const updates: { name?: string; isActive?: boolean; disabledUntil?: Date | null } = {};
  const manuallyReenabled = input.isActive === true || input.disabledUntil === null;
  const now = new Date();
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) return yield* Effect.fail(internal("Please enter a name"));
    updates.name = name;
  }

  if (input.disabledUntil instanceof Date) {
    if (input.disabledUntil <= now) return yield* Effect.fail(internal("Please choose a future time"));
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
    yield* fromPromise(
      () => db.update(providerAccount).set(updates).where(eq(providerAccount.id, input.id)),
      "Failed to update account"
    );
    if (manuallyReenabled) yield* clearRefreshFailCount(input.id);
    if (manuallyReenabled && account.status === "failed") {
      yield* accelerateAccountCooldownForManualEnable(input.id, now);
    }
    if (updates.isActive !== undefined || updates.disabledUntil !== undefined) {
      yield* invalidateDisabledModelsCache(userId);
    }
  }

  const updatedRows = yield* fromPromise(
    () =>
      db
        .select({ id: providerAccount.id, name: providerAccount.name, isActive: providerAccount.isActive, disabledUntil: providerAccount.disabledUntil, status: providerAccount.status, statusChangedAt: providerAccount.statusChangedAt, consecutiveErrors: providerAccount.consecutiveErrors })
        .from(providerAccount)
        .where(eq(providerAccount.id, input.id))
        .limit(1),
    "Failed to update account"
  );
  const updated = updatedRows[0];
  if (!updated) return yield* Effect.fail(internal("Account not found"));

  publishAccountsChanged(userId);
  return { ...withEffectiveActive(updated, now), unhealthyCount: updated.consecutiveErrors };
});

const accelerateAccountCooldownForManualEnable = Effect.fn("accounts.accelerateCooldown")(function* (
  accountId: string,
  now = new Date()
) {
  yield* fromPromise(
    () =>
      db.transaction(async (tx) => {
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

        const stillCoolingDown = total >= UNHEALTHY_THRESHOLD;
        await tx
          .update(providerAccount)
          .set({
            status: stillCoolingDown ? "failed" : "active",
            statusChangedAt: now,
            consecutiveErrors: total,
            disabledUntil: stillCoolingDown ? new Date(now.getTime() + ACCOUNT_COOLDOWN_MS) : null,
          })
          .where(eq(providerAccount.id, accountId));
      }),
    "Failed to update account cooldown"
  );
});

export const deleteAccount = Effect.fn("accounts.delete")(function* (
  userId: string,
  input: DeleteAccountInput
) {
  return yield* deleteAccountInner(userId, input).pipe(
    Effect.map(() => ({ success: true as const, data: undefined })),
    Effect.catch((failure: { message: string }) => failWith(failure.message))
  );
});

const deleteAccountInner = Effect.fnUntraced(function* (
  userId: string,
  input: DeleteAccountInput
) {
  const accountRows = yield* fromPromise(
    () =>
      db
        .select({ id: providerAccount.id, email: providerAccount.email })
        .from(providerAccount)
        .where(and(eq(providerAccount.id, input.id), eq(providerAccount.userId, userId)))
        .limit(1),
    "Failed to load account"
  );
  const account = accountRows[0];
  if (!account) return yield* Effect.fail(internal("Account not found"));

  if (account.email) yield* trackProviderEmail(userId, account.email);
  yield* fromPromise(
    () => db.delete(providerAccount).where(eq(providerAccount.id, input.id)),
    "Failed to delete account"
  );
  yield* invalidateDisabledModelsCache(userId);
  yield* clearRefreshFailCount(input.id);
  publishAccountsChanged(userId);
  return undefined;
});

export const togglePinnedProvider = Effect.fn("accounts.togglePinned")(function* (
  userId: string,
  input: TogglePinnedProviderInput
) {
  if (!PROVIDER_KEY_PATTERN.test(input.providerKey)) return failWith("Invalid provider");

  return yield* togglePinnedProviderInner(userId, input).pipe(
    Effect.map((data) => ({ success: true as const, data })),
    Effect.catch((failure: { message: string }) => failWith(failure.message))
  );
});

const togglePinnedProviderInner = Effect.fnUntraced(function* (
  userId: string,
  input: TogglePinnedProviderInput
) {
  const existing = yield* fromPromise(
    () =>
      db
        .select({ id: pinnedProvider.id })
        .from(pinnedProvider)
        .where(and(eq(pinnedProvider.userId, userId), eq(pinnedProvider.providerKey, input.providerKey)))
        .limit(1),
    "Failed to load pinned provider"
  );

  if (existing[0]) {
    yield* fromPromise(
      () => db.delete(pinnedProvider).where(eq(pinnedProvider.id, existing[0]!.id)),
      "Failed to update pinned provider"
    );
    publishAccountsChanged(userId);
    return { providerKey: input.providerKey, pinned: false };
  }

  yield* fromPromise(
    () =>
      db
        .insert(pinnedProvider)
        .values({ userId, providerKey: input.providerKey })
        .onConflictDoNothing({ target: [pinnedProvider.userId, pinnedProvider.providerKey] }),
    "Failed to update pinned provider"
  );
  publishAccountsChanged(userId);
  return { providerKey: input.providerKey, pinned: true };
});

export const setAccountModelEnabled = Effect.fn("accounts.setModelEnabled")(function* (
  userId: string,
  input: SetAccountModelEnabledInput
) {
  return yield* setAccountModelEnabledInner(userId, input).pipe(
    Effect.map((data) => ({ success: true as const, data })),
    Effect.catch((failure: { message: string }) => failWith(failure.message))
  );
});

const setAccountModelEnabledInner = Effect.fnUntraced(function* (
  userId: string,
  input: SetAccountModelEnabledInput
) {
  const accountRows = yield* fromPromise(
    () =>
      db
        .select({ id: providerAccount.id, provider: providerAccount.provider, tier: providerAccount.tier })
        .from(providerAccount)
        .where(and(eq(providerAccount.id, input.accountId), eq(providerAccount.userId, userId)))
        .limit(1),
    "Failed to load account"
  );
  const account = accountRows[0];
  if (!account) return yield* Effect.fail(internal("Account not found"));

  const normalizedModel = resolveModelAlias(input.modelId.trim());
  if (!normalizedModel || !getProviderModelSet(account.provider).has(normalizedModel)) {
    return yield* Effect.fail(
      internal(`Model "${normalizedModel || input.modelId}" is not supported by provider "${account.provider}"`)
    );
  }
  if (!accountTierCanAccessModel(account.tier, normalizedModel, account.provider)) {
    return yield* Effect.fail(
      internal(`Model "${normalizedModel}" is not available for this account tier`)
    );
  }

  const lookupKeys = getModelLookupKeys(normalizedModel);
  yield* fromPromise(
    () =>
      db
        .delete(providerAccountDisabledModel)
        .where(
          and(
            eq(providerAccountDisabledModel.providerAccountId, account.id),
            inArray(providerAccountDisabledModel.model, lookupKeys)
          )
        ),
    "Failed to update model status"
  );
  if (!input.enabled) {
    yield* fromPromise(
      () =>
        db
          .insert(providerAccountDisabledModel)
          .values({ providerAccountId: account.id, model: normalizedModel })
          .onConflictDoNothing({
            target: [providerAccountDisabledModel.providerAccountId, providerAccountDisabledModel.model],
          }),
      "Failed to update model status"
    );
  }

  yield* invalidateDisabledModelsCache(userId);
  publishAccountsChanged(userId);
  return { model: normalizedModel, enabled: input.enabled };
});

export const getAccountErrorHistory = Effect.fn("accounts.errorHistory")(function* (
  userId: string,
  input: ErrorHistoryInput
) {
  const accountRows = yield* fromPromise(
    () =>
      db
        .select({ id: providerAccount.id })
        .from(providerAccount)
        .where(and(eq(providerAccount.id, input.accountId), eq(providerAccount.userId, userId)))
        .limit(1),
    "Failed to load account"
  ).pipe(Effect.catch(() => Effect.succeed([])));
  if (!accountRows[0]) return { success: true as const, data: { entries: [] } };

  const entries = yield* readRedisErrorHistory(
    input.accountId,
    Math.min(input.limit ?? DEFAULT_ERROR_HISTORY_ROWS, MAX_ERROR_HISTORY_ROWS)
  ).pipe(Effect.catch(() => Effect.succeed([])));

  return { success: true as const, data: { entries } };
});

export const getAccountErrorHistories = Effect.fn("accounts.errorHistories")(function* (
  userId: string,
  input: ErrorHistoryBatchInput
) {
  const accountIds = Array.from(new Set(input.accountIds));
  if (accountIds.length === 0) return { success: true as const, data: {} };

  const ownedAccounts = yield* fromPromise(
    () =>
      db
        .select({ id: providerAccount.id })
        .from(providerAccount)
        .where(and(eq(providerAccount.userId, userId), inArray(providerAccount.id, accountIds))),
    "Failed to load accounts"
  ).pipe(Effect.catch(() => Effect.succeed([])));
  const ownedAccountIds = ownedAccounts.map((account) => account.id);
  const entriesByAccountId = yield* readRedisErrorHistories(
    ownedAccountIds,
    Math.min(input.limit ?? DEFAULT_ERROR_HISTORY_ROWS, MAX_ERROR_HISTORY_ROWS)
  ).pipe(Effect.catch(() => Effect.succeed({} as Record<string, never[]>)));
  const results = Object.fromEntries(
    accountIds.map((accountId) => {
      const entries = entriesByAccountId[accountId];
      if (!entries) return [accountId, { success: false, error: "Account not found" }];
      return [accountId, { success: true, data: { entries } }];
    })
  );

  return { success: true as const, data: results };
});

export const getAccountSession = Effect.fn("accounts.session")(function* (
  userId: string,
  input: AccountSessionInput
) {
  const accountRows = yield* fromPromise(
    () =>
      db
        .select({ accessToken: providerAccount.accessToken, refreshToken: providerAccount.refreshToken, apiKey: providerAccount.apiKey, accountId: providerAccount.accountId, provider: providerAccount.provider, email: providerAccount.email })
        .from(providerAccount)
        .where(and(eq(providerAccount.id, input.id), eq(providerAccount.userId, userId)))
        .limit(1),
    "Failed to read account session"
  ).pipe(Effect.catch(() => Effect.succeed([])));
  const account = accountRows[0];
  if (!account) return failWith("Account not found");

  return yield* Effect.try({
    try: () => ({ success: true as const, data: { session: decrypt(account.accessToken) } }),
    catch: () => internal("Failed to read account session"),
  }).pipe(Effect.catch(() => failWith("Failed to read account session")));
});

export const resolveAccountErrors = Effect.fn("accounts.resolveErrors")(function* (
  userId: string,
  input: ResolveErrorsInput
) {
  return yield* resolveAccountErrorsInner(userId, input).pipe(
    Effect.map(() => ({ success: true as const, data: undefined })),
    Effect.catch((failure: { message: string }) => failWith(failure.message))
  );
});

const resolveAccountErrorsInner = Effect.fnUntraced(function* (
  userId: string,
  input: ResolveErrorsInput
) {
  const accountRows = yield* fromPromise(
    () =>
      db
        .select({ id: providerAccount.id, status: providerAccount.status })
        .from(providerAccount)
        .where(and(eq(providerAccount.id, input.accountId), eq(providerAccount.userId, userId)))
        .limit(1),
    "Failed to load account"
  );
  const account = accountRows[0];
  if (!account) return yield* Effect.fail(internal("Account not found"));

  yield* fromPromise(
    () =>
      db
        .update(providerAccount)
        .set({
          errorCount: 0,
          consecutiveErrors: 0,
          lastErrorAt: null,
          lastErrorCode: null,
          lastRecoveredByRotationAt: null,
          ...(account.status === "failed" ? { status: "active", statusChangedAt: new Date(), disabledUntil: null } : {}),
        })
        .where(eq(providerAccount.id, input.accountId)),
    "Failed to resolve account errors"
  );
  yield* deleteRedisErrorHistory(input.accountId);
  yield* fromPromise(
    () =>
      db
        .delete(providerAccountModelHealth)
        .where(eq(providerAccountModelHealth.providerAccountId, input.accountId)),
    "Failed to resolve account errors"
  );
  yield* clearRefreshFailCount(input.accountId);
  publishAccountsChanged(userId);
  return undefined;
});
