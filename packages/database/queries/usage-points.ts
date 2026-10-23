import { and, eq, gte, lt, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { createId } from "@paralleldrive/cuid2";
import { Effect } from "effect";
import { db, type DbExecutor } from "../client.js";
import { tryDb } from "../errors.js";
import { pointTransaction, usageLog, userPointBalance } from "../schema/usage.js";

export type InsertUsageLogParams = {
  id?: string;
  userId: string;
  providerAccountId: string | null;
  proxyApiKeyId: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  statusCode: number | null;
  duration: number | null;
  createdAt: Date;
};

export const insertUsageLog = Effect.fn("db.insertUsageLog")(function* (params: InsertUsageLogParams, database: DbExecutor = db) {
  yield* tryDb("query", () => database.insert(usageLog).values({
    id: params.id ?? createId(),
    userId: params.userId,
    providerAccountId: params.providerAccountId,
    proxyApiKeyId: params.proxyApiKeyId,
    model: params.model,
    inputTokens: params.inputTokens,
    outputTokens: params.outputTokens,
    cachedTokens: params.cachedTokens,
    cacheWriteTokens: params.cacheWriteTokens,
    statusCode: params.statusCode,
    duration: params.duration,
    createdAt: params.createdAt,
  }));
});

export const debitPointBalance = Effect.fn("db.debitPointBalance")(function* (
  params: { userId: string; amount: number; at: Date },
  database: DbExecutor = db
) {
  const rows = yield* tryDb("query", () => database
    .update(userPointBalance)
    .set({ balance: sql`${userPointBalance.balance} - ${params.amount}`, updatedAt: params.at })
    .where(and(eq(userPointBalance.userId, params.userId), gte(userPointBalance.balance, params.amount)))
    .returning({ balance: userPointBalance.balance }));
  return rows[0]?.balance ?? null;
});

export const debitPointBalanceAllowNegative = Effect.fn("db.debitPointBalanceAllowNegative")(function* (
  params: { userId: string; amount: number; at: Date },
  database: DbExecutor = db
) {
  const rows = yield* tryDb("query", () => database
    .update(userPointBalance)
    .set({ balance: sql`${userPointBalance.balance} - ${params.amount}`, updatedAt: params.at })
    .where(eq(userPointBalance.userId, params.userId))
    .returning({ balance: userPointBalance.balance }));
  return rows[0]?.balance ?? null;
});

export const creditPointBalance = Effect.fn("db.creditPointBalance")(function* (
  params: { userId: string; amount: number; at: Date },
  database: DbExecutor = db
) {
  const rows = yield* tryDb("query", () => database
    .update(userPointBalance)
    .set({ balance: sql`${userPointBalance.balance} + ${params.amount}`, updatedAt: params.at })
    .where(eq(userPointBalance.userId, params.userId))
    .returning({ balance: userPointBalance.balance }));
  return rows[0]?.balance ?? null;
});

export type InsertPointTransactionParams = {
  id?: string;
  userId: string;
  amount: number;
  type: string;
  balanceAfter: number;
  idempotencyKey: string | null;
  usageLogId: string | null;
  createdAt: Date;
};

export const insertPointTransaction = Effect.fn("db.insertPointTransaction")(function* (
  params: InsertPointTransactionParams,
  database: DbExecutor = db
) {
  yield* tryDb("query", () => database.insert(pointTransaction).values({
    id: params.id ?? createId(),
    userId: params.userId,
    amount: params.amount,
    type: params.type,
    balanceAfter: params.balanceAfter,
    idempotencyKey: params.idempotencyKey,
    usageLogId: params.usageLogId,
    createdAt: params.createdAt,
  }));
});

export const insertPointTransactionOnConflictDoNothing = Effect.fn("db.insertPointTransactionOnConflictDoNothing")(function* (
  params: InsertPointTransactionParams,
  database: DbExecutor = db
) {
  const result = yield* tryDb("query", () => database
    .insert(pointTransaction)
    .values({
      id: params.id ?? createId(),
      userId: params.userId,
      amount: params.amount,
      type: params.type,
      balanceAfter: params.balanceAfter,
      idempotencyKey: params.idempotencyKey,
      usageLogId: params.usageLogId,
      createdAt: params.createdAt,
    })
    .onConflictDoNothing({ target: pointTransaction.idempotencyKey })
    .returning({ id: pointTransaction.id }));
  return result.length;
});

export const updatePointTransactionBalance = Effect.fn("db.updatePointTransactionBalance")(function* (
  params: { id: string; balanceAfter: number },
  database: DbExecutor = db
) {
  yield* tryDb("query", () => database
    .update(pointTransaction)
    .set({ balanceAfter: params.balanceAfter })
    .where(eq(pointTransaction.id, params.id)));
});

export type OrphanedRoamingDebitParams = {
  olderThan: Date;
  limit: number;
};

export type OrphanedRoamingDebit = {
  id: string;
  userId: string;
  amount: number;
  createdAt: Date;
};

export const listOrphanedRoamingDebits = Effect.fn("db.listOrphanedRoamingDebits")(function* (
  params: OrphanedRoamingDebitParams,
  database: DbExecutor = db
) {
  const settlement = alias(pointTransaction, "settlement");
  const rows = yield* tryDb("query", () => database
    .select({
      id: pointTransaction.id,
      userId: pointTransaction.userId,
      amount: pointTransaction.amount,
      createdAt: pointTransaction.createdAt,
    })
    .from(pointTransaction)
    .where(
      and(
        eq(pointTransaction.type, "roaming_debit"),
        lt(pointTransaction.createdAt, params.olderThan),
        sql`not exists (
          select 1 from ${settlement}
          where ${settlement.idempotencyKey} in (
            'roaming_refund:' || ${pointTransaction.id},
            'roaming_settle:' || ${pointTransaction.id},
            'sharing_credit:' || ${pointTransaction.id}
          )
        )`,
      )
    )
    .orderBy(pointTransaction.createdAt)
    .limit(params.limit));
  return rows.map((row) => ({
    id: row.id,
    userId: row.userId,
    amount: row.amount,
    createdAt: row.createdAt,
  }));
});

export const insertPointBalanceOnConflictDoNothing = Effect.fn("db.insertPointBalanceOnConflictDoNothing")(function* (
  params: { userId: string; balance: number; createdAt: Date; updatedAt: Date },
  database: DbExecutor = db
) {
  const result = yield* tryDb("query", () => database
    .insert(userPointBalance)
    .values({
      userId: params.userId,
      balance: params.balance,
      createdAt: params.createdAt,
      updatedAt: params.updatedAt,
    })
    .onConflictDoNothing({ target: userPointBalance.userId })
    .returning({ userId: userPointBalance.userId }));
  return result.length;
});
