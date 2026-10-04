import { randomUUID } from "node:crypto";
import {
  creditPointBalance,
  debitPointBalance,
  debitPointBalanceAllowNegative,
  insertPointBalanceOnConflictDoNothing,
  insertPointTransaction,
  insertPointTransactionOnConflictDoNothing,
  updatePointTransactionBalance,
} from "@opendum/database/queries";
import type { Database } from "@opendum/database";
import type { Registry } from "@opendum/models/runtime";
import type { UsageCounts } from "./types.js";

const INITIAL_POINT_BALANCE = 15;
const ROAMING_MINIMUM_POINTS = 1;
const POINTS_PER_MILLION = 1_000_000;

export type PointReservation = {
  userId: string;
  model: string;
  amount: number;
  debitId: string;
};

type Tx = Database;

async function ensurePointBalance(database: Database, userId: string, now: Date): Promise<void> {
  const affected = await insertPointBalanceOnConflictDoNothing(
    { userId, balance: INITIAL_POINT_BALANCE, createdAt: now, updatedAt: now },
    database
  );
  if (affected > 0) {
    await insertPointTransactionOnConflictDoNothing(
      {
        id: randomUUID(),
        userId,
        amount: INITIAL_POINT_BALANCE,
        type: "initial_grant",
        balanceAfter: INITIAL_POINT_BALANCE,
        idempotencyKey: `initial:${userId}`,
        usageLogId: null,
        createdAt: now,
      },
      database
    );
  }
}

export function roamingPoints(registry: Registry | null, model: string, usage: UsageCounts | null): number {
  let points = 0;
  if (usage && registry) {
    const cost = registry.modelCost(model);
    if (cost) {
      const billableInput = Math.max(0, usage.inputTokens - usage.cachedTokens);
      points =
        (billableInput * (cost.input ?? 0) +
          usage.cachedTokens * (cost.cacheRead ?? 0) +
          usage.outputTokens * (cost.output ?? 0) +
          usage.cacheWriteTokens * (cost.cacheWrite ?? 0)) /
        POINTS_PER_MILLION;
    }
  }
  const total = Math.ceil(points);
  return total < ROAMING_MINIMUM_POINTS ? ROAMING_MINIMUM_POINTS : total;
}

export async function reserveRoamingPoint(
  database: Database,
  userId: string,
  model: string
): Promise<PointReservation | null> {
  if (!userId) return { userId, model, amount: 0, debitId: "" };
  const reservation: PointReservation = {
    userId,
    model,
    amount: ROAMING_MINIMUM_POINTS,
    debitId: randomUUID(),
  };
  const now = new Date();
  return database.transaction(async (tx) => {
    const txDb = tx as unknown as Tx;
    await ensurePointBalance(txDb, userId, now);
    const balanceAfter = await debitPointBalance(
      { userId, amount: reservation.amount, at: now },
      txDb
    );
    if (balanceAfter === null) return null;
    await insertPointTransaction(
      {
        id: reservation.debitId,
        userId,
        amount: -reservation.amount,
        type: "roaming_debit",
        balanceAfter,
        idempotencyKey: null,
        usageLogId: null,
        createdAt: now,
      },
      txDb
    );
    return reservation;
  });
}

export async function refundRoamingPoint(database: Database, reservation: PointReservation | null): Promise<void> {
  if (!reservation || !reservation.userId || reservation.amount <= 0) return;
  const now = new Date();
  const idempotencyKey = `roaming_refund:${reservation.debitId}`;
  await database.transaction(async (tx) => {
    const txDb = tx as unknown as Tx;
    await ensurePointBalance(txDb, reservation.userId, now);
    const transactionId = randomUUID();
    const affected = await insertPointTransactionOnConflictDoNothing(
      {
        id: transactionId,
        userId: reservation.userId,
        amount: reservation.amount,
        type: "roaming_refund",
        balanceAfter: 0,
        idempotencyKey,
        usageLogId: null,
        createdAt: now,
      },
      txDb
    );
    if (affected === 0) return;
    const balanceAfter = await creditPointBalance(
      { userId: reservation.userId, amount: reservation.amount, at: now },
      txDb
    );
    await updatePointTransactionBalance({ id: transactionId, balanceAfter: balanceAfter ?? 0 }, txDb);
  });
}

export async function adjustRoamingPoints(
  database: Database,
  reservation: PointReservation | null,
  points: number
): Promise<void> {
  if (!reservation || !reservation.userId) return;
  const delta = points - reservation.amount;
  if (delta === 0) return;
  const now = new Date();
  const idempotencyKey = `roaming_settle:${reservation.debitId}`;
  await database.transaction(async (tx) => {
    const txDb = tx as unknown as Tx;
    await ensurePointBalance(txDb, reservation.userId, now);
    const transactionId = randomUUID();
    const affected = await insertPointTransactionOnConflictDoNothing(
      {
        id: transactionId,
        userId: reservation.userId,
        amount: -delta,
        type: "roaming_settle",
        balanceAfter: 0,
        idempotencyKey,
        usageLogId: null,
        createdAt: now,
      },
      txDb
    );
    if (affected === 0) return;
    const balanceAfter =
      delta > 0
        ? await debitPointBalanceAllowNegative({ userId: reservation.userId, amount: delta, at: now }, txDb)
        : await creditPointBalance({ userId: reservation.userId, amount: -delta, at: now }, txDb);
    await updatePointTransactionBalance({ id: transactionId, balanceAfter: balanceAfter ?? 0 }, txDb);
  });
}

export async function settleRoamingPoint(
  database: Database,
  registry: Registry | null,
  ownerUserId: string,
  reservation: PointReservation | null,
  model: string,
  usage: UsageCounts | null
): Promise<void> {
  if (!reservation) return;
  const points = roamingPoints(registry, model, usage);
  await adjustRoamingPoints(database, reservation, points);
  await creditSharingPoint(database, ownerUserId, reservation.debitId, points);
}

export async function creditSharingPoint(
  database: Database,
  ownerUserId: string,
  debitId: string,
  amount: number
): Promise<void> {
  if (!ownerUserId || !debitId || amount <= 0) return;
  const now = new Date();
  const idempotencyKey = `sharing_credit:${debitId}`;
  await database.transaction(async (tx) => {
    const txDb = tx as unknown as Tx;
    await ensurePointBalance(txDb, ownerUserId, now);
    const transactionId = randomUUID();
    const affected = await insertPointTransactionOnConflictDoNothing(
      {
        id: transactionId,
        userId: ownerUserId,
        amount,
        type: "sharing_credit",
        balanceAfter: 0,
        idempotencyKey,
        usageLogId: null,
        createdAt: now,
      },
      txDb
    );
    if (affected === 0) return;
    const balanceAfter = await creditPointBalance({ userId: ownerUserId, amount, at: now }, txDb);
    await updatePointTransactionBalance({ id: transactionId, balanceAfter: balanceAfter ?? 0 }, txDb);
  });
}

export async function ensureUserPointBalance(database: Database, userId: string): Promise<void> {
  await ensurePointBalance(database, userId, new Date());
}
