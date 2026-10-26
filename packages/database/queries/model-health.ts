import { and, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { Effect } from "effect";
import { db, type DbExecutor } from "../client.js";
import { tryDb } from "../errors.js";
import { providerAccount, accountModelHealth } from "../schema/accounts.js";

export const bumpRequests = Effect.fn("db.bumpRequests")(function* (
  params: { id: string; at: Date },
  database: DbExecutor = db
) {
  yield* tryDb("query", () => database
    .update(providerAccount)
    .set({ lastUsedAt: params.at, requestCount: sql`${providerAccount.requestCount} + 1` })
    .where(eq(providerAccount.id, params.id)));
});

export const healthState = Effect.fn("db.healthState")(function* (id: string, database: DbExecutor = db) {
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

export const markFailed = Effect.fn("db.markFailed")(function* (
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

export const markLimited = Effect.fn("db.markLimited")(function* (
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

export const markRecovered = Effect.fn("db.markRecovered")(function* (
  params: { id: string; at: Date; beforeOrAt: Date },
  database: DbExecutor = db
) {
  yield* tryDb("query", () => database
    .update(providerAccount)
    .set({ lastRecoveredAt: params.at })
    .where(and(eq(providerAccount.id, params.id), lte(providerAccount.lastErrorAt, params.beforeOrAt))));
});

export const modelHealthColumns = {
  id: accountModelHealth.id,
  providerAccountId: accountModelHealth.providerAccountId,
  model: accountModelHealth.model,
  consecutiveErrors: accountModelHealth.consecutiveErrors,
  status: accountModelHealth.status,
  statusChangedAt: accountModelHealth.statusChangedAt,
  lastErrorAt: accountModelHealth.lastErrorAt,
  lastErrorCode: accountModelHealth.lastErrorCode,
  lastSuccessAt: accountModelHealth.lastSuccessAt,
  unhealthyCountUpdatedAt: accountModelHealth.unhealthyCountUpdatedAt,
  createdAt: accountModelHealth.createdAt,
  updatedAt: accountModelHealth.updatedAt,
  quotaLockedUntil: accountModelHealth.quotaLockedUntil,
  quotaLockReason: accountModelHealth.quotaLockReason,
} as const;

export const healthByAccounts = Effect.fn("db.healthByAccounts")(function* (
  params: { accountIds: string[]; models: string[] },
  database: DbExecutor = db
) {
  if (params.accountIds.length === 0 || params.models.length === 0) return [];
  return yield* tryDb("query", () =>
    database
      .select(modelHealthColumns)
      .from(accountModelHealth)
      .where(
        and(
          inArray(accountModelHealth.providerAccountId, params.accountIds),
          inArray(accountModelHealth.model, params.models)
        )
      )
  );
});

export const healthByAccount = Effect.fn("db.healthByAccount")(function* (
  accountId: string,
  database: DbExecutor = db
) {
  return yield* tryDb("query", () =>
    database
      .select(modelHealthColumns)
      .from(accountModelHealth)
      .where(eq(accountModelHealth.providerAccountId, accountId))
  );
});

export const getModelHealth = Effect.fn("db.getModelHealth")(function* (
  accountId: string,
  model: string,
  database: DbExecutor = db
) {
  const rows = yield* tryDb("query", () => database
    .select(modelHealthColumns)
    .from(accountModelHealth)
    .where(
      and(
        eq(accountModelHealth.providerAccountId, accountId),
        eq(accountModelHealth.model, model)
      )
    )
    .limit(1));
  return rows[0] ?? null;
});

export const bumpCounters = Effect.fn("db.bumpCounters")(function* (
  params: { id: string; consecutiveErrors: number; unhealthyCountUpdatedAt: Date },
  database: DbExecutor = db
) {
  yield* tryDb("query", () => database
    .update(accountModelHealth)
    .set({
      consecutiveErrors: params.consecutiveErrors,
      unhealthyCountUpdatedAt: params.unhealthyCountUpdatedAt,
    })
    .where(eq(accountModelHealth.id, params.id)));
});

export const setStatus = Effect.fn("db.setStatus")(function* (
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
    .update(accountModelHealth)
    .set({
      consecutiveErrors: params.consecutiveErrors,
      unhealthyCountUpdatedAt: params.unhealthyCountUpdatedAt,
      status: params.status,
      statusChangedAt: params.statusChangedAt,
    })
    .where(eq(accountModelHealth.id, params.id)));
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
  yield* tryDb("query", () => database.insert(accountModelHealth).values(params));
});

export const markUsageLimited = Effect.fn("db.markUsageLimited")(function* (
  params: { providerAccountId: string; model: string; status: string; at: Date; consecutiveErrors: number },
  database: DbExecutor = db
) {
  yield* tryDb("query", () => database
    .update(accountModelHealth)
    .set({
      status: params.status,
      statusChangedAt: params.at,
      consecutiveErrors: params.consecutiveErrors,
      lastErrorAt: params.at,
      unhealthyCountUpdatedAt: params.at,
    })
    .where(
      and(
        eq(accountModelHealth.providerAccountId, params.providerAccountId),
        eq(accountModelHealth.model, params.model)
      )
    ));
});

export const markSuccess = Effect.fn("db.markSuccess")(function* (
  params: {
    id: string;
    consecutiveErrors: number;
    lastSuccessAt: Date;
    unhealthyCountUpdatedAt: Date;
  },
  database: DbExecutor = db
) {
  yield* tryDb("query", () => database
    .update(accountModelHealth)
    .set({
      consecutiveErrors: params.consecutiveErrors,
      lastSuccessAt: params.lastSuccessAt,
      unhealthyCountUpdatedAt: params.unhealthyCountUpdatedAt,
    })
    .where(eq(accountModelHealth.id, params.id)));
});

export const successStatus = Effect.fn("db.successStatus")(function* (
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
    .update(accountModelHealth)
    .set({
      consecutiveErrors: params.consecutiveErrors,
      lastSuccessAt: params.lastSuccessAt,
      unhealthyCountUpdatedAt: params.unhealthyCountUpdatedAt,
      status: params.status,
      statusChangedAt: params.statusChangedAt,
    })
    .where(eq(accountModelHealth.id, params.id)));
});

export const recordFailure = Effect.fn("db.recordFailure")(function* (
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
    .update(accountModelHealth)
    .set({
      consecutiveErrors: params.consecutiveErrors,
      lastErrorAt: params.lastErrorAt,
      lastErrorCode: params.lastErrorCode,
      unhealthyCountUpdatedAt: params.unhealthyCountUpdatedAt,
    })
    .where(eq(accountModelHealth.id, params.id)));
});

export const failStatus = Effect.fn("db.failStatus")(function* (
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
    .update(accountModelHealth)
    .set({
      consecutiveErrors: params.consecutiveErrors,
      lastErrorAt: params.lastErrorAt,
      lastErrorCode: params.lastErrorCode,
      unhealthyCountUpdatedAt: params.unhealthyCountUpdatedAt,
      status: params.status,
      statusChangedAt: params.statusChangedAt,
    })
    .where(eq(accountModelHealth.id, params.id)));
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
    .insert(accountModelHealth)
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
      target: [accountModelHealth.providerAccountId, accountModelHealth.model],
      set: {
        quotaLockedUntil: params.quotaLockedUntil,
        quotaLockReason: params.quotaLockReason,
        updatedAt: params.at,
      },
    }));
});

export const clearQuotaLock = Effect.fn("db.clearQuotaLock")(function* (
  params: { providerAccountId: string; model: string },
  database: DbExecutor = db
) {
  yield* tryDb("query", () => database
    .update(accountModelHealth)
    .set({ quotaLockedUntil: null, quotaLockReason: null })
    .where(
      and(
        eq(accountModelHealth.providerAccountId, params.providerAccountId),
        eq(accountModelHealth.model, params.model),
        isNotNull(accountModelHealth.quotaLockedUntil)
      )
    ));
});
