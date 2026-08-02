import { and, eq, sql } from "drizzle-orm";
import type { ProxyDB } from "../db/index.js";
import { schema } from "../db/index.js";
import { newID } from "../db/id.js";

export const initialPointBalance = 15;
export const roamingPointCost = 2;

export interface PointReservation {
  userId: string;
  amount: number;
  debitID: string;
}

export class InsufficientPointsError extends Error {
  constructor() {
    super("insufficient points");
    this.name = "InsufficientPointsError";
  }
}

async function ensurePointBalanceTx(db: ProxyDB, userId: string, now: Date): Promise<void> {
  const inserted = await db
    .insert(schema.userPointBalance)
    .values({ userId, balance: initialPointBalance, createdAt: now, updatedAt: now })
    .onConflictDoNothing({ target: schema.userPointBalance.userId });
  const rowsAffected = inserted.rowCount ?? 0;
  if (rowsAffected > 0) {
    const idempotencyKey = `initial:${userId}`;
    await db
      .insert(schema.pointTransaction)
      .values({ id: newID(), userId, amount: initialPointBalance, type: "initial_grant", balanceAfter: initialPointBalance, idempotencyKey, createdAt: now })
      .onConflictDoNothing({ target: schema.pointTransaction.idempotencyKey });
  }
}

export async function reserveRoamingPoint(db: ProxyDB | null, userId: string): Promise<[PointReservation | null, boolean, Error | null]> {
  if (userId === "") return [{ userId, amount: 0, debitID: "" }, true, null];
  if (!db) return [null, false, new Error("no db")];

  const reservation: PointReservation = { userId, amount: roamingPointCost, debitID: newID() };
  const now = new Date();

  try {
    await db.transaction(async (tx) => {
      await ensurePointBalanceTx(tx, userId, now);
      const result = await tx.execute(
        sql`UPDATE user_point_balance SET balance = balance - ${reservation.amount}, "updatedAt" = ${now} WHERE "userId" = ${userId} AND balance >= ${reservation.amount} RETURNING balance`,
      );
      const rows = result.rows as Array<{ balance: number }>;
      if (rows.length === 0) {
        throw new InsufficientPointsError();
      }
      const balanceAfter = Number(rows[0]!.balance);
      await tx.insert(schema.pointTransaction).values({
        id: reservation.debitID,
        userId,
        amount: -reservation.amount,
        type: "roaming_debit",
        balanceAfter,
        createdAt: now,
      });
    });
  } catch (error) {
    if (error instanceof InsufficientPointsError) return [null, false, null];
    return [null, false, error as Error];
  }

  return [reservation, true, null];
}

export async function refundRoamingPoint(db: ProxyDB | null, reservation: PointReservation | null): Promise<void> {
  if (!reservation || reservation.userId === "" || reservation.amount <= 0 || !db) return;

  const now = new Date();
  const idempotencyKey = "roaming_refund:" + reservation.debitID;

  try {
    await db.transaction(async (tx) => {
      await ensurePointBalanceTx(tx, reservation.userId, now);
      const transactionID = newID();
      const inserted = await tx
        .insert(schema.pointTransaction)
        .values({ id: transactionID, userId: reservation.userId, amount: reservation.amount, type: "roaming_refund", balanceAfter: 0, idempotencyKey, createdAt: now })
        .onConflictDoNothing({ target: schema.pointTransaction.idempotencyKey });
      if ((inserted.rowCount ?? 0) === 0) return;

      const result = await tx.execute(sql`UPDATE user_point_balance SET balance = balance + ${reservation.amount}, "updatedAt" = ${now} WHERE "userId" = ${reservation.userId} RETURNING balance`);
      const rows = result.rows as Array<{ balance: number }>;
      if (rows.length === 0) return;
      const balanceAfter = Number(rows[0]!.balance);
      await tx.update(schema.pointTransaction).set({ balanceAfter }).where(eq(schema.pointTransaction.id, transactionID));
    });
  } catch {
    // ignore refund failures
  }
}

export async function creditSharingPoint(db: ProxyDB | null, ownerUserID: string, debitID: string, amount: number): Promise<void> {
  if (ownerUserID === "" || debitID === "" || amount <= 0 || !db) return;

  const now = new Date();
  const idempotencyKey = "sharing_credit:" + debitID;

  try {
    await db.transaction(async (tx) => {
      await ensurePointBalanceTx(tx, ownerUserID, now);
      const transactionID = newID();
      const inserted = await tx
        .insert(schema.pointTransaction)
        .values({ id: transactionID, userId: ownerUserID, amount, type: "sharing_credit", balanceAfter: 0, idempotencyKey, createdAt: now })
        .onConflictDoNothing({ target: schema.pointTransaction.idempotencyKey });
      if ((inserted.rowCount ?? 0) === 0) return;

      const result = await tx.execute(sql`UPDATE user_point_balance SET balance = balance + ${amount}, "updatedAt" = ${now} WHERE "userId" = ${ownerUserID} RETURNING balance`);
      const rows = result.rows as Array<{ balance: number }>;
      if (rows.length === 0) return;
      const balanceAfter = Number(rows[0]!.balance);
      await tx.update(schema.pointTransaction).set({ balanceAfter }).where(eq(schema.pointTransaction.id, transactionID));
    });
  } catch {
    // ignore credit failures
  }
}
