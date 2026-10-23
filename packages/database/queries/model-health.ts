import { and, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { Effect } from "effect";
import { db, type DbExecutor } from "../client.js";
import { tryDb } from "../errors.js";
import { providerAccount, providerAccountModelHealth } from "../schema/accounts.js";

export const bumpAccountRequestCount = Effect.fn("db.bumpAccountRequestCount")(function* (
  params: { id: string; at: Date },
  database: DbExecutor = db
) {
  yield* tryDb("query", () => database
    .update(providerAccount)
    .set({ lastUsedAt: params.at, requestCount: sql`${providerAccount.requestCount} + 1` })
    .where(eq(providerAccount.id, params.id)));
});

export const getAccountHealthState = Effect.fn("db.getAccountHealthState")(function* (id: string, database: DbExecutor = db) {
  const rows = yield* tryDb("query", () => database
    .select({
      id: providerAccount.id,
      status: providerAccount.status,
      disabledUntil: providerAccount.disabledUntil,
      consecutiveErrors: providerAccount.consecutiveErrors,
    })
    .from(providerAccount)
    .where(eq(providerAccount.id, id))
    .limit(1));
  return rows[0] ?? null;
});

export const setAccountHealthFailed = Effect.fn("db.setAccountHealthFailed")(function* (
  params: { id: string; consecutiveErrors: number; status: string; at: Date },
  database: DbExecutor = db
) {
  yield* tryDb("query", () => database
    .update(providerAccount)
    .set({
      consecutiveErrors: params.consecutiveErrors,
      status: params.status,
      statusChangedAt: params.at,
    })
    .where(eq(providerAccount.id, params.id)));
});

export const setAccountCooldown = Effect.fn("db.setAccountCooldown")(function* (
  params: {
    id: string;
    status: string;
    at: Date;
    consecutiveErrors: number;
    disabledUntil: Date;
  },
  database: DbExecutor = db
) {
  yield* tryDb("query", () => database
    .update(providerAccount)
    .set({
      status: params.status,
      statusChangedAt: params.at,
      consecutiveErrors: params.consecutiveErrors,
      disabledUntil: params.disabledUntil,
    })
    .where(eq(providerAccount.id, params.id)));
});

export const setAccountActive = Effect.fn("db.setAccountActive")(function* (
  params: { id: string; status: string; at: Date; consecutiveErrors: number },
  database: DbExecutor = db
) {
  yield* tryDb("query", () => database
    .update(providerAccount)
    .set({
      status: params.status,
      statusChangedAt: params.at,
      consecutiveErrors: params.consecutiveErrors,
      disabledUntil: null,
    })
    .where(eq(providerAccount.id, params.id)));
});

export const setAccountUsageLimited = Effect.fn("db.setAccountUsageLimited")(function* (
  params: { id: string; disabledUntil: Date; status: string; at: Date },
  database: DbExecutor = db
) {
  yield* tryDb("query", () => database
    .update(providerAccount)
    .set({ disabledUntil: params.disabledUntil, status: params.status, statusChangedAt: params.at })
    .where(eq(providerAccount.id, params.id)));
});

export const recordRequestError = Effect.fn("db.recordRequestError")(function* (
  params: { id: string; at: Date; code: number | null },
  database: DbExecutor = db
) {
  yield* tryDb("query", () => database
    .update(providerAccount)
    .set({
      errorCount: sql`${providerAccount.errorCount} + 1`,
      lastErrorAt: params.at,
      lastErrorCode: params.code,
    })
    .where(eq(providerAccount.id, params.id)));
});

export const markAccountSuccess = Effect.fn("db.markAccountSuccess")(function* (
  params: { id: string; at: Date },
  database: DbExecutor = db
) {
  yield* tryDb("query", () => database
    .update(providerAccount)
    .set({ successCount: sql`${providerAccount.successCount} + 1`, lastSuccessAt: params.at })
    .where(eq(providerAccount.id, params.id)));
});

export const markAccountRecoveredByRotation = Effect.fn("db.markAccountRecoveredByRotation")(function* (
  params: { id: string; at: Date; beforeOrAt: Date },
  database: DbExecutor = db
) {
  yield* tryDb("query", () => database
    .update(providerAccount)
    .set({ lastRecoveredByRotationAt: params.at })
    .where(and(eq(providerAccount.id, params.id), lte(providerAccount.lastErrorAt, params.beforeOrAt))));
});

export const modelHealthColumns = {
  id: providerAccountModelHealth.id,
  providerAccountId: providerAccountModelHealth.providerAccountId,
  model: providerAccountModelHealth.model,
  consecutiveErrors: providerAccountModelHealth.consecutiveErrors,
  status: providerAccountModelHealth.status,
  statusChangedAt: providerAccountModelHealth.statusChangedAt,
  lastErrorAt: providerAccountModelHealth.lastErrorAt,
  lastErrorCode: providerAccountModelHealth.lastErrorCode,
  lastSuccessAt: providerAccountModelHealth.lastSuccessAt,
  unhealthyCountUpdatedAt: providerAccountModelHealth.unhealthyCountUpdatedAt,
  createdAt: providerAccountModelHealth.createdAt,
  updatedAt: providerAccountModelHealth.updatedAt,
  quotaLockedUntil: providerAccountModelHealth.quotaLockedUntil,
  quotaLockReason: providerAccountModelHealth.quotaLockReason,
} as const;

export const listModelHealthByAccounts = Effect.fn("db.listModelHealthByAccounts")(function* (
  params: { accountIds: string[]; models: string[] },
  database: DbExecutor = db
) {
  if (params.accountIds.length === 0 || params.models.length === 0) return [];
  return yield* tryDb("query", () =>
    database
      .select(modelHealthColumns)
      .from(providerAccountModelHealth)
      .where(
        and(
          inArray(providerAccountModelHealth.providerAccountId, params.accountIds),
          inArray(providerAccountModelHealth.model, params.models)
        )
      )
  );
});

export const listModelHealthByAccount = Effect.fn("db.listModelHealthByAccount")(function* (
  accountId: string,
  database: DbExecutor = db
) {
  return yield* tryDb("query", () =>
    database
      .select(modelHealthColumns)
      .from(providerAccountModelHealth)
      .where(eq(providerAccountModelHealth.providerAccountId, accountId))
  );
});

export const getModelHealth = Effect.fn("db.getModelHealth")(function* (
  accountId: string,
  model: string,
  database: DbExecutor = db
) {
  const rows = yield* tryDb("query", () => database
    .select(modelHealthColumns)
    .from(providerAccountModelHealth)
    .where(
      and(
        eq(providerAccountModelHealth.providerAccountId, accountId),
        eq(providerAccountModelHealth.model, model)
      )
    )
    .limit(1));
  return rows[0] ?? null;
});

export const updateModelHealthCounters = Effect.fn("db.updateModelHealthCounters")(function* (
  params: { id: string; consecutiveErrors: number; unhealthyCountUpdatedAt: Date },
  database: DbExecutor = db
) {
  yield* tryDb("query", () => database
    .update(providerAccountModelHealth)
    .set({
      consecutiveErrors: params.consecutiveErrors,
      unhealthyCountUpdatedAt: params.unhealthyCountUpdatedAt,
    })
    .where(eq(providerAccountModelHealth.id, params.id)));
});

export const updateModelHealthStatus = Effect.fn("db.updateModelHealthStatus")(function* (
  params: {
    id: string;
    consecutiveErrors: number;
    unhealthyCountUpdatedAt: Date;
    status: string;
    statusChangedAt: Date;
  },
  database: DbExecutor = db
) {
  yield* tryDb("query", () => database
    .update(providerAccountModelHealth)
    .set({
      consecutiveErrors: params.consecutiveErrors,
      unhealthyCountUpdatedAt: params.unhealthyCountUpdatedAt,
      status: params.status,
      statusChangedAt: params.statusChangedAt,
    })
    .where(eq(providerAccountModelHealth.id, params.id)));
});

export const insertModelHealth = Effect.fn("db.insertModelHealth")(function* (
  params: {
    id: string;
    providerAccountId: string;
    model: string;
    consecutiveErrors: number;
    status: string;
    lastErrorAt: Date | null;
    lastErrorCode: number | null;
    unhealthyCountUpdatedAt: Date;
    createdAt: Date;
    updatedAt: Date;
  },
  database: DbExecutor = db
) {
  yield* tryDb("query", () => database.insert(providerAccountModelHealth).values(params));
});

export const markUsageLimitedHealth = Effect.fn("db.markUsageLimitedHealth")(function* (
  params: { providerAccountId: string; model: string; status: string; at: Date; consecutiveErrors: number },
  database: DbExecutor = db
) {
  yield* tryDb("query", () => database
    .update(providerAccountModelHealth)
    .set({
      status: params.status,
      statusChangedAt: params.at,
      consecutiveErrors: params.consecutiveErrors,
      lastErrorAt: params.at,
      unhealthyCountUpdatedAt: params.at,
    })
    .where(
      and(
        eq(providerAccountModelHealth.providerAccountId, params.providerAccountId),
        eq(providerAccountModelHealth.model, params.model)
      )
    ));
});

export const updateModelHealthSuccess = Effect.fn("db.updateModelHealthSuccess")(function* (
  params: {
    id: string;
    consecutiveErrors: number;
    lastSuccessAt: Date;
    unhealthyCountUpdatedAt: Date;
  },
  database: DbExecutor = db
) {
  yield* tryDb("query", () => database
    .update(providerAccountModelHealth)
    .set({
      consecutiveErrors: params.consecutiveErrors,
      lastSuccessAt: params.lastSuccessAt,
      unhealthyCountUpdatedAt: params.unhealthyCountUpdatedAt,
    })
    .where(eq(providerAccountModelHealth.id, params.id)));
});

export const updateModelHealthSuccessWithStatus = Effect.fn("db.updateModelHealthSuccessWithStatus")(function* (
  params: {
    id: string;
    consecutiveErrors: number;
    lastSuccessAt: Date;
    unhealthyCountUpdatedAt: Date;
    status: string;
    statusChangedAt: Date;
  },
  database: DbExecutor = db
) {
  yield* tryDb("query", () => database
    .update(providerAccountModelHealth)
    .set({
      consecutiveErrors: params.consecutiveErrors,
      lastSuccessAt: params.lastSuccessAt,
      unhealthyCountUpdatedAt: params.unhealthyCountUpdatedAt,
      status: params.status,
      statusChangedAt: params.statusChangedAt,
    })
    .where(eq(providerAccountModelHealth.id, params.id)));
});

export const updateModelHealthFailure = Effect.fn("db.updateModelHealthFailure")(function* (
  params: {
    id: string;
    consecutiveErrors: number;
    lastErrorAt: Date;
    lastErrorCode: number | null;
    unhealthyCountUpdatedAt: Date;
  },
  database: DbExecutor = db
) {
  yield* tryDb("query", () => database
    .update(providerAccountModelHealth)
    .set({
      consecutiveErrors: params.consecutiveErrors,
      lastErrorAt: params.lastErrorAt,
      lastErrorCode: params.lastErrorCode,
      unhealthyCountUpdatedAt: params.unhealthyCountUpdatedAt,
    })
    .where(eq(providerAccountModelHealth.id, params.id)));
});

export const updateModelHealthFailureWithStatus = Effect.fn("db.updateModelHealthFailureWithStatus")(function* (
  params: {
    id: string;
    consecutiveErrors: number;
    lastErrorAt: Date;
    lastErrorCode: number | null;
    unhealthyCountUpdatedAt: Date;
    status: string;
    statusChangedAt: Date;
  },
  database: DbExecutor = db
) {
  yield* tryDb("query", () => database
    .update(providerAccountModelHealth)
    .set({
      consecutiveErrors: params.consecutiveErrors,
      lastErrorAt: params.lastErrorAt,
      lastErrorCode: params.lastErrorCode,
      unhealthyCountUpdatedAt: params.unhealthyCountUpdatedAt,
      status: params.status,
      statusChangedAt: params.statusChangedAt,
    })
    .where(eq(providerAccountModelHealth.id, params.id)));
});

export const lockModelQuota = Effect.fn("db.lockModelQuota")(function* (
  params: {
    id: string;
    providerAccountId: string;
    model: string;
    quotaLockedUntil: Date | null;
    quotaLockReason: string | null;
    at: Date;
  },
  database: DbExecutor = db
) {
  yield* tryDb("query", () => database
    .insert(providerAccountModelHealth)
    .values({
      id: params.id,
      providerAccountId: params.providerAccountId,
      model: params.model,
      consecutiveErrors: 0,
      status: "active",
      quotaLockedUntil: params.quotaLockedUntil,
      quotaLockReason: params.quotaLockReason,
      createdAt: params.at,
      updatedAt: params.at,
    })
    .onConflictDoUpdate({
      target: [providerAccountModelHealth.providerAccountId, providerAccountModelHealth.model],
      set: {
        quotaLockedUntil: params.quotaLockedUntil,
        quotaLockReason: params.quotaLockReason,
        updatedAt: params.at,
      },
    }));
});

export const clearModelQuotaLock = Effect.fn("db.clearModelQuotaLock")(function* (
  params: { providerAccountId: string; model: string },
  database: DbExecutor = db
) {
  yield* tryDb("query", () => database
    .update(providerAccountModelHealth)
    .set({ quotaLockedUntil: null, quotaLockReason: null })
    .where(
      and(
        eq(providerAccountModelHealth.providerAccountId, params.providerAccountId),
        eq(providerAccountModelHealth.model, params.model),
        isNotNull(providerAccountModelHealth.quotaLockedUntil)
      )
    ));
});
