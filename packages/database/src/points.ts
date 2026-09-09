import { sql, eq } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import type { Database } from "./client.js";
import { pointTransaction, userPointBalance } from "./schema/index.js";

export const INITIAL_POINT_BALANCE = 15;
export const ROAMING_POINT_COST = 2;

export interface PointReservation {
  userId: string;
  amount: number;
  debitId: string;
}

export async function ensurePointBalance(db: Database, userId: string, now: Date = new Date()): Promise<void> {
  const inserted = await db
    .insert(userPointBalance)
    .values({
      userId,
      balance: INITIAL_POINT_BALANCE,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: userPointBalance.userId })
    .returning();

  if (inserted.length > 0) {
    await db
      .insert(pointTransaction)
      .values({
        id: createId(),
        userId,
        amount: INITIAL_POINT_BALANCE,
        type: "initial_grant",
        balanceAfter: INITIAL_POINT_BALANCE,
        idempotencyKey: `initial:${userId}`,
        createdAt: now,
      })
      .onConflictDoNothing({ target: pointTransaction.idempotencyKey });
  }
}

export async function reserveRoamingPoint(
  db: Database,
  userId: string
): Promise<{ reservation: PointReservation | null; sufficient: boolean }> {
  if (!userId) {
    return { reservation: null, sufficient: true };
  }

  const reservation: PointReservation = {
    userId,
    amount: ROAMING_POINT_COST,
    debitId: createId(),
  };
  const now = new Date();

  return await db.transaction(async (tx) => {
    await ensurePointBalance(tx as unknown as Database, userId, now);

    const updated = await tx
      .update(userPointBalance)
      .set({
        balance: sql`${userPointBalance.balance} - ${reservation.amount}`,
        updatedAt: now,
      })
      .where(sql`${userPointBalance.userId} = ${userId} AND ${userPointBalance.balance} >= ${reservation.amount}`)
      .returning({ balanceAfter: userPointBalance.balance });

    if (updated.length === 0) {
      return { reservation: null, sufficient: false };
    }

    const balanceAfter = updated[0]?.balanceAfter ?? 0;

    await tx.insert(pointTransaction).values({
      id: reservation.debitId,
      userId,
      amount: -reservation.amount,
      type: "roaming_debit",
      balanceAfter,
      createdAt: now,
    });

    return { reservation, sufficient: true };
  });
}

export async function refundRoamingPoint(
  db: Database,
  reservation: PointReservation | null | undefined
): Promise<void> {
  if (!reservation || !reservation.userId || reservation.amount <= 0) {
    return;
  }

  const now = new Date();
  const idempotencyKey = `roaming_refund:${reservation.debitId}`;

  await db.transaction(async (tx) => {
    await ensurePointBalance(tx as unknown as Database, reservation.userId, now);

    const inserted = await tx
      .insert(pointTransaction)
      .values({
        id: createId(),
        userId: reservation.userId,
        amount: reservation.amount,
        type: "roaming_refund",
        balanceAfter: 0,
        idempotencyKey,
        createdAt: now,
      })
      .onConflictDoNothing({ target: pointTransaction.idempotencyKey })
      .returning();

    if (inserted.length === 0) {
      return;
    }

    const updated = await tx
      .update(userPointBalance)
      .set({
        balance: sql`${userPointBalance.balance} + ${reservation.amount}`,
        updatedAt: now,
      })
      .where(eq(userPointBalance.userId, reservation.userId))
      .returning({ balanceAfter: userPointBalance.balance });

    const balanceAfter = updated[0]?.balanceAfter ?? 0;

    await tx
      .update(pointTransaction)
      .set({ balanceAfter })
      .where(eq(pointTransaction.id, inserted[0]!.id));
  });
}

export async function creditSharingPoint(
  db: Database,
  ownerUserId: string,
  debitId: string,
  amount: number
): Promise<void> {
  if (!ownerUserId || !debitId || amount <= 0) {
    return;
  }

  const now = new Date();
  const idempotencyKey = `sharing_credit:${debitId}`;

  await db.transaction(async (tx) => {
    await ensurePointBalance(tx as unknown as Database, ownerUserId, now);

    const inserted = await tx
      .insert(pointTransaction)
      .values({
        id: createId(),
        userId: ownerUserId,
        amount,
        type: "sharing_credit",
        balanceAfter: 0,
        idempotencyKey,
        createdAt: now,
      })
      .onConflictDoNothing({ target: pointTransaction.idempotencyKey })
      .returning();

    if (inserted.length === 0) {
      return;
    }

    const updated = await tx
      .update(userPointBalance)
      .set({
        balance: sql`${userPointBalance.balance} + ${amount}`,
        updatedAt: now,
      })
      .where(eq(userPointBalance.userId, ownerUserId))
      .returning({ balanceAfter: userPointBalance.balance });

    const balanceAfter = updated[0]?.balanceAfter ?? 0;

    await tx
      .update(pointTransaction)
      .set({ balanceAfter })
      .where(eq(pointTransaction.id, inserted[0]!.id));
  });
}
