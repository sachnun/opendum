import { and, eq, gte, sql } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import { db, type Database } from "#database/client.ts";
import { pointTransaction, usageLog, userPointBalance } from "#database/schema/usage.ts";

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

export async function insertUsageLog(params: InsertUsageLogParams, database: Database = db) {
  await database.insert(usageLog).values({
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
  });
}

export async function debitPointBalance(
  params: { userId: string; amount: number; at: Date },
  database: Database = db
) {
  const [row] = await database
    .update(userPointBalance)
    .set({ balance: sql`${userPointBalance.balance} - ${params.amount}`, updatedAt: params.at })
    .where(and(eq(userPointBalance.userId, params.userId), gte(userPointBalance.balance, params.amount)))
    .returning({ balance: userPointBalance.balance });
  return row?.balance ?? null;
}

export async function debitPointBalanceAllowNegative(
  params: { userId: string; amount: number; at: Date },
  database: Database = db
) {
  const [row] = await database
    .update(userPointBalance)
    .set({ balance: sql`${userPointBalance.balance} - ${params.amount}`, updatedAt: params.at })
    .where(eq(userPointBalance.userId, params.userId))
    .returning({ balance: userPointBalance.balance });
  return row?.balance ?? null;
}

export async function creditPointBalance(
  params: { userId: string; amount: number; at: Date },
  database: Database = db
) {
  const [row] = await database
    .update(userPointBalance)
    .set({ balance: sql`${userPointBalance.balance} + ${params.amount}`, updatedAt: params.at })
    .where(eq(userPointBalance.userId, params.userId))
    .returning({ balance: userPointBalance.balance });
  return row?.balance ?? null;
}

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

export async function insertPointTransaction(
  params: InsertPointTransactionParams,
  database: Database = db
) {
  await database.insert(pointTransaction).values({
    id: params.id ?? createId(),
    userId: params.userId,
    amount: params.amount,
    type: params.type,
    balanceAfter: params.balanceAfter,
    idempotencyKey: params.idempotencyKey,
    usageLogId: params.usageLogId,
    createdAt: params.createdAt,
  });
}

export async function insertPointTransactionOnConflictDoNothing(
  params: InsertPointTransactionParams,
  database: Database = db
) {
  const result = await database
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
    .onConflictDoNothing({ target: pointTransaction.idempotencyKey });
  return result.rowCount ?? 0;
}

export async function updatePointTransactionBalance(
  params: { id: string; balanceAfter: number },
  database: Database = db
) {
  await database
    .update(pointTransaction)
    .set({ balanceAfter: params.balanceAfter })
    .where(eq(pointTransaction.id, params.id));
}

export async function insertPointBalanceOnConflictDoNothing(
  params: { userId: string; balance: number; createdAt: Date; updatedAt: Date },
  database: Database = db
) {
  const result = await database
    .insert(userPointBalance)
    .values({
      userId: params.userId,
      balance: params.balance,
      createdAt: params.createdAt,
      updatedAt: params.updatedAt,
    })
    .onConflictDoNothing({ target: userPointBalance.userId });
  return result.rowCount ?? 0;
}
