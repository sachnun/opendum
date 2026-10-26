import { Effect } from "effect";
import { db, pinnedProvider, providerAccount, accountDisabledModel, accountModelHealth } from "@opendum/database";
import { fromPromise } from "@opendum/api/web/lib/task";
import { internal } from "@opendum/api/web/errors";
import type { AccountSessionInput, AccountStatsInput, DeleteAccountInput, HistoryBatchInput, ErrorHistoryInput, ProviderDetailInput, ProviderInput, ResolveErrorsInput, ModelToggleInput, PinToggleInput, UpdateAccountInput } from "@opendum/providers/contract";
import { publishAccounts } from "@opendum/api/web/events/bus";
import { keysOf, providerSet, aliasOf } from "@opendum/api/web/lib/proxy/models";
import { clearFails, invalidateDisabled } from "@opendum/api/web/lib/proxy/auth";
import { decrypt } from "@opendum/api/web/lib/encryption";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { isKnown, PROVIDER_ACCOUNT_KEYS } from "@opendum/api/web/services/account-providers";
import { customProviderModels } from "@opendum/api/web/services/custom-providers";
import { trackProviderEmail } from "@opendum/api/web/services/points";
import { buildAccountStats, emptyStats, providerSummary, type ProviderAccountIndicator, type ProviderStats } from "@opendum/api/web/services/account-stats";
import {
  AccountState,
  Clock,
  ErrorHistory,
  Health,
  HealthRows,
  ModelList,
  Pins,
  Tier,
  UNHEALTHY_THRESHOLD,
  type AccountHealthAggregate,
  type HealthRow,
  type AccountOverviewSummary,
  type AccountReadOptions,
} from "@opendum/api/web/services/accounts-helpers";

export { createAccount } from "@opendum/api/web/services/account-connectors";

const ACCOUNT_COOLDOWN_MS = 10 * 60 * 1000;
const DEFAULT_HISTORY_ROWS = 100;
const MAX_HISTORY_ROWS = 200;

type HealthRecoveryRow = HealthRow & {
  id: string;
  updatedAt: Date | string | null;
  createdAt: Date | string | null;
};

interface OverviewOptions extends AccountReadOptions {}

const PROVIDER_KEY_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const listColumns = {
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
  lastRecoveredAt: providerAccount.lastRecoveredAt,
  lastErrorCode: providerAccount.lastErrorCode,
  successCount: providerAccount.successCount,
  createdAt: providerAccount.createdAt,
};

const lastUsedOrder = [sql`${providerAccount.lastUsedAt} desc nulls last`, desc(providerAccount.createdAt), desc(providerAccount.id)] as const;

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
        .select(listColumns)
        .from(providerAccount)
        .where(eq(providerAccount.userId, userId))
        .orderBy(asc(providerAccount.createdAt)),
    "Failed to list accounts"
  );
  return accounts.map((account) => ({
    ...AccountState.withActive(account, now),
    unhealthyCount: account.consecutiveErrors,
  }));
});

export const listByProvider = Effect.fn("accounts.listByProvider")(function* (
  userId: string,
  input: ProviderInput
) {
  return yield* listInner(userId, input).pipe(
    Effect.mapError((failure) => internal("Failed to list provider accounts", failure.cause ?? failure))
  );
});

const listInner = Effect.fnUntraced(function* (
  userId: string,
  input: ProviderInput
) {
  const now = new Date();
  const accounts = yield* fromPromise(
    () =>
      db
        .select(listColumns)
        .from(providerAccount)
        .where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, input.provider)))
        .orderBy(...lastUsedOrder),
    "Failed to list provider accounts"
  );
  return accounts.map((account) => ({
    ...AccountState.withActive(account, now),
    unhealthyCount: account.consecutiveErrors,
  }));
});

export const getAccountOverview = Effect.fn("accounts.overview")(function* (
  userId: string,
  options: OverviewOptions = {}
) {
  return yield* buildAccountOverview(userId, options).pipe(
    Effect.mapError((failure) => internal("Failed to load account summaries", failure.cause ?? failure))
  );
});

const buildAccountOverview = Effect.fnUntraced(function* (
  userId: string,
  options: OverviewOptions = {}
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
          lastRecoveredAt: providerAccount.lastRecoveredAt,
        })
        .from(providerAccount)
            .where(eq(providerAccount.userId, userId)),
        "Failed to load accounts"
      ),
      providerSummary(userId),
    ], { concurrency: "unbounded" });
    const [pinnedProviders, healthRows] = yield* Effect.all([
      Pins.load(userId, accounts.map((account) => account.provider), options),
      HealthRows.load(accounts.map((account) => account.id)),
    ], { concurrency: "unbounded" });

    const pingSummaries = Health.pingSummaries(accounts, Health.aggregate(healthRows, now, AccountState.cooldownRecoveryIds(accounts, now)), now);

    const providerKeys = Array.from(new Set<string>([...PROVIDER_ACCOUNT_KEYS, ...accounts.map((account) => account.provider)]));
    const summaries = Object.fromEntries(
      providerKeys.map((provider) => [
        provider,
        {
          ...(pingSummaries[provider] ?? { connected: 0, active: 0, indicator: "normal" as ProviderAccountIndicator }),
          stats: providerStats[provider] ?? emptyStats(),
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
        lastRecoveredAt: providerAccount.lastRecoveredAt,
      })
      .from(providerAccount)
      .where(eq(providerAccount.userId, userId)), "Failed to load accounts");
    const [pinnedProviders, healthRows] = yield* Effect.all([
      Pins.load(userId, accounts.map((account) => account.provider), options),
      HealthRows.load(accounts.map((account) => account.id)),
    ], { concurrency: "unbounded" });

    const pingSummaries = Health.pingSummaries(accounts, Health.aggregate(healthRows, now, AccountState.cooldownRecoveryIds(accounts, now)), now);

    return {
      summaries: Object.fromEntries(pinnedProviders.map((provider) => [provider, pingSummaries[provider]])),
      pinnedProviders,
      hasConnectedAccounts: accounts.length > 0,
    };
  }
});

export const accountsDetailed = Effect.fn("accounts.detail")(function* (
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
      .select(listColumns)
      .from(providerAccount)
      .where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, input.provider)))
      .orderBy(...lastUsedOrder), "Failed to load provider accounts");

    const accountIds = accounts.map((account) => account.id);
    const isBuiltin = isKnown(input.provider);
    const customModels = isBuiltin ? [] : yield* customProviderModels(userId, input.provider);
    const providerModels = isBuiltin ? Array.from(providerSet(input.provider)) : customModels;
    const supportedByAccount = Object.fromEntries(accounts.map((account) => [
      account.id,
      isBuiltin ? Tier.modelsFor(input.provider, account.tier) : customModels,
    ]));
    const supportedModels = ModelList.sort(
      isBuiltin
        ? providerModels.filter((model) =>
            input.provider === "codex"
              ? true
              : Tier.accessibleByAccounts(model, input.provider, accounts)
          )
        : providerModels
    );
    const freeSupportedModels = isBuiltin ? Tier.modelsFor(input.provider, "free") : customModels;
    const healthModelKeys = Array.from(new Set(supportedModels.flatMap((model) => keysOf(model))));
    const [disabledModelRows, healthRows, pinnedProviders] = yield* Effect.all([
      accountIds.length > 0
        ? fromPromise(
            () =>
              db
                .select({ providerAccountId: accountDisabledModel.providerAccountId, model: accountDisabledModel.model })
                .from(accountDisabledModel)
                .where(inArray(accountDisabledModel.providerAccountId, accountIds)),
            "Failed to load disabled account models"
          )
        : Effect.succeed([]),
      accountIds.length > 0 && healthModelKeys.length > 0
        ? fromPromise(() => db
            .select({
              providerAccountId: accountModelHealth.providerAccountId,
              model: accountModelHealth.model,
              status: accountModelHealth.status,
              statusChangedAt: accountModelHealth.statusChangedAt,
              consecutiveErrors: accountModelHealth.consecutiveErrors,
              lastErrorAt: accountModelHealth.lastErrorAt,
              lastErrorCode: accountModelHealth.lastErrorCode,
              lastSuccessAt: accountModelHealth.lastSuccessAt,
              unhealthyCountUpdatedAt: accountModelHealth.unhealthyCountUpdatedAt,
            })
            .from(accountModelHealth)
            .where(and(inArray(accountModelHealth.providerAccountId, accountIds), inArray(accountModelHealth.model, healthModelKeys))), "Failed to load account model health")
        : Effect.succeed([]),
      Pins.load(userId),
    ], { concurrency: "unbounded" });

    const disabledModels = disabledModelRows.reduce<Record<string, string[]>>((acc, row) => {
      acc[row.providerAccountId] = [...(acc[row.providerAccountId] ?? []), row.model];
      return acc;
    }, {});

    const recoveryIds = AccountState.cooldownRecoveryIds(accounts, now);
    const effectiveHealthRows = healthRows.map((row) => Health.withEffective(row, now, recoveryIds.has(row.providerAccountId)));
    const healthById = effectiveHealthRows.reduce<Record<string, AccountHealthAggregate>>((acc, row) => {
      const current = acc[row.providerAccountId] ?? { unhealthyCount: 0, warningCount: 0, lastErrorAt: null, lastSuccessAt: null };
      current.unhealthyCount += row.consecutiveErrors;
      if (Health.actionable(row)) current.warningCount += row.consecutiveErrors;
      if ((Clock.ms(row.lastErrorAt) ?? 0) > (Clock.ms(current.lastErrorAt) ?? 0)) current.lastErrorAt = row.lastErrorAt;
      if ((Clock.ms(row.lastSuccessAt) ?? 0) > (Clock.ms(current.lastSuccessAt) ?? 0)) current.lastSuccessAt = row.lastSuccessAt;
      acc[row.providerAccountId] = current;
      return acc;
    }, {});
    const modelHealth = effectiveHealthRows.reduce<Record<string, Record<string, { status: string; consecutiveErrors: number; lastErrorAt: Date | string | null; lastSuccessAt: Date | string | null }>>>((acc, row) => {
      const model = aliasOf(row.model);
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
      const health = healthById[account.id];
      const unhealthyCount = health?.unhealthyCount ?? account.consecutiveErrors;
      const status = AccountState.hasCooldown(account, now) || unhealthyCount >= UNHEALTHY_THRESHOLD ? "failed" : "active";

      return {
        ...AccountState.withActive(account, now),
        status,
        consecutiveErrors: unhealthyCount,
        unhealthyCount,
        lastErrorAt: health?.lastErrorAt ?? account.lastErrorAt,
        lastSuccessAt: health?.lastSuccessAt ?? account.lastSuccessAt,
        stats: emptyStats(),
      };
    });

    return {
      accounts: detailedAccounts,
      supportedModels,
      freeSupportedModels,
      supportedByAccount,
      disabledModelsByAccountId: disabledModels,
      modelHealthByAccountId: modelHealth,
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
    if (manuallyReenabled) yield* clearFails(input.id);
    if (manuallyReenabled && account.status === "failed") {
      yield* accelerateCooldown(input.id, now);
    }
    if (updates.isActive !== undefined || updates.disabledUntil !== undefined) {
      yield* invalidateDisabled(userId);
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

  publishAccounts(userId);
  return { ...AccountState.withActive(updated, now), unhealthyCount: updated.consecutiveErrors };
});

const accelerateCooldown = Effect.fn("accounts.accelerateCooldown")(function* (
  accountId: string,
  now = new Date()
) {
  yield* fromPromise(
    () =>
      db.transaction(async (tx) => {
        const rows: HealthRecoveryRow[] = await tx
          .select({
            id: accountModelHealth.id,
            providerAccountId: accountModelHealth.providerAccountId,
            status: accountModelHealth.status,
            statusChangedAt: accountModelHealth.statusChangedAt,
            consecutiveErrors: accountModelHealth.consecutiveErrors,
            lastErrorAt: accountModelHealth.lastErrorAt,
            lastErrorCode: accountModelHealth.lastErrorCode,
            lastSuccessAt: accountModelHealth.lastSuccessAt,
            unhealthyCountUpdatedAt: accountModelHealth.unhealthyCountUpdatedAt,
            updatedAt: accountModelHealth.updatedAt,
            createdAt: accountModelHealth.createdAt,
          })
          .from(accountModelHealth)
          .where(eq(accountModelHealth.providerAccountId, accountId));

        let total = 0;
        for (const row of rows) {
          const recovered = Health.withEffective(row, now, true);
          total += recovered.consecutiveErrors;
          const patch: { consecutiveErrors: number; unhealthyCountUpdatedAt: Date; status?: string; statusChangedAt?: Date } = {
            consecutiveErrors: recovered.consecutiveErrors,
            unhealthyCountUpdatedAt: now,
          };
          if (row.status === "failed" || recovered.status !== row.status) {
            patch.status = recovered.status;
            patch.statusChangedAt = now;
          }
          await tx.update(accountModelHealth).set(patch).where(eq(accountModelHealth.id, row.id));
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
  yield* invalidateDisabled(userId);
  yield* clearFails(input.id);
  publishAccounts(userId);
  return undefined;
});

export const togglePinnedProvider = Effect.fn("accounts.togglePinned")(function* (
  userId: string,
  input: PinToggleInput
) {
  if (!PROVIDER_KEY_PATTERN.test(input.providerKey)) return failWith("Invalid provider");

  return yield* togglePinInner(userId, input).pipe(
    Effect.map((data) => ({ success: true as const, data })),
    Effect.catch((failure: { message: string }) => failWith(failure.message))
  );
});

const togglePinInner = Effect.fnUntraced(function* (
  userId: string,
  input: PinToggleInput
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
    publishAccounts(userId);
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
  publishAccounts(userId);
  return { providerKey: input.providerKey, pinned: true };
});

export const enableModel = Effect.fn("accounts.enableModel")(function* (
  userId: string,
  input: ModelToggleInput
) {
  return yield* enableInner(userId, input).pipe(
    Effect.map((data) => ({ success: true as const, data })),
    Effect.catch((failure: { message: string }) => failWith(failure.message))
  );
});

const enableInner = Effect.fnUntraced(function* (
  userId: string,
  input: ModelToggleInput
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

  const normalizedModel = aliasOf(input.modelId.trim());
  if (!normalizedModel || !providerSet(account.provider).has(normalizedModel)) {
    return yield* Effect.fail(
      internal(`Model "${normalizedModel || input.modelId}" is not supported by provider "${account.provider}"`)
    );
  }
  if (!Tier.canAccess(account.tier, normalizedModel, account.provider)) {
    return yield* Effect.fail(
      internal(`Model "${normalizedModel}" is not available for this account tier`)
    );
  }

  const lookupKeys = keysOf(normalizedModel);
  yield* fromPromise(
    () =>
      db
        .delete(accountDisabledModel)
        .where(
          and(
            eq(accountDisabledModel.providerAccountId, account.id),
            inArray(accountDisabledModel.model, lookupKeys)
          )
        ),
    "Failed to update model status"
  );
  if (!input.enabled) {
    yield* fromPromise(
      () =>
        db
          .insert(accountDisabledModel)
          .values({ providerAccountId: account.id, model: normalizedModel })
          .onConflictDoNothing({
            target: [accountDisabledModel.providerAccountId, accountDisabledModel.model],
          }),
      "Failed to update model status"
    );
  }

  yield* invalidateDisabled(userId);
  publishAccounts(userId);
  return { model: normalizedModel, enabled: input.enabled };
});

export const errorHistory = Effect.fn("accounts.errorHistory")(function* (
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

  const entries = yield* ErrorHistory.read(
    input.accountId,
    Math.min(input.limit ?? DEFAULT_HISTORY_ROWS, MAX_HISTORY_ROWS)
  ).pipe(Effect.catch(() => Effect.succeed([])));

  return { success: true as const, data: { entries } };
});

export const errorHistories = Effect.fn("accounts.errorHistories")(function* (
  userId: string,
  input: HistoryBatchInput
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
  const entriesByAccount = yield* ErrorHistory.readMany(
    ownedAccountIds,
    Math.min(input.limit ?? DEFAULT_HISTORY_ROWS, MAX_HISTORY_ROWS)
  ).pipe(Effect.catch(() => Effect.succeed({} as Record<string, never[]>)));
  const results = Object.fromEntries(
    accountIds.map((accountId) => {
      const entries = entriesByAccount[accountId];
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
  return yield* resolveInner(userId, input).pipe(
    Effect.map(() => ({ success: true as const, data: undefined })),
    Effect.catch((failure: { message: string }) => failWith(failure.message))
  );
});

const resolveInner = Effect.fnUntraced(function* (
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
          lastRecoveredAt: null,
          ...(account.status === "failed" ? { status: "active", statusChangedAt: new Date(), disabledUntil: null } : {}),
        })
        .where(eq(providerAccount.id, input.accountId)),
    "Failed to resolve account errors"
  );
  yield* ErrorHistory.remove(input.accountId);
  yield* fromPromise(
    () =>
      db
        .delete(accountModelHealth)
        .where(eq(accountModelHealth.providerAccountId, input.accountId)),
    "Failed to resolve account errors"
  );
  yield* clearFails(input.accountId);
  publishAccounts(userId);
  return undefined;
});
