import { and, eq, gte, sql } from "drizzle-orm";

import { db, type Database } from "../lib/db";
import { pointTransaction, userPointBalance } from "../lib/db/schema";

export const INITIAL_POINT_BALANCE = 15;
export const API_KEY_UPDATE_POINT_COST = 100;

type PointDatabase = Pick<Database, "insert" | "select" | "update">;

async function ensureUserPointBalanceWithClient(client: PointDatabase, userId: string): Promise<number> {
  const [created] = await client
      .insert(userPointBalance)
      .values({ userId, balance: INITIAL_POINT_BALANCE })
      .onConflictDoNothing({ target: userPointBalance.userId })
      .returning({ balance: userPointBalance.balance });

  if (created) {
    const idempotencyKey = `initial:${userId}`;

    await client
        .insert(pointTransaction)
        .values({
          userId,
          amount: INITIAL_POINT_BALANCE,
          type: "initial_grant",
          balanceAfter: INITIAL_POINT_BALANCE,
          idempotencyKey,
        })
        .onConflictDoNothing({ target: pointTransaction.idempotencyKey });

    return created.balance;
  }

  const [existing] = await client
      .select({ balance: userPointBalance.balance })
      .from(userPointBalance)
      .where(eq(userPointBalance.userId, userId))
      .limit(1);

  return existing?.balance ?? INITIAL_POINT_BALANCE;
}

export async function ensureUserPointBalance(userId: string): Promise<number> {
  return db.transaction((tx) => ensureUserPointBalanceWithClient(tx, userId));
}

export async function debitUserPoints(client: PointDatabase, userId: string, amount: number, type: string): Promise<{ success: true; balance: number } | { success: false; balance: number }> {
  if (amount <= 0) throw new Error("Point debit amount must be positive");

  await ensureUserPointBalanceWithClient(client, userId);

  const [debited] = await client
    .update(userPointBalance)
    .set({
      balance: sql`${userPointBalance.balance} - ${amount}`,
      updatedAt: new Date(),
    })
    .where(and(eq(userPointBalance.userId, userId), gte(userPointBalance.balance, amount)))
    .returning({ balance: userPointBalance.balance });

  if (!debited) {
    const [existing] = await client
      .select({ balance: userPointBalance.balance })
      .from(userPointBalance)
      .where(eq(userPointBalance.userId, userId))
      .limit(1);

    return { success: false, balance: existing?.balance ?? 0 };
  }

  await client.insert(pointTransaction).values({
    userId,
    amount: -amount,
    type,
    balanceAfter: debited.balance,
  });

  return { success: true, balance: debited.balance };
}
