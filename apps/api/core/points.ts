import { Effect } from "effect";
import type { PointPort } from "./repositories.js";
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

async function ensurePointBalance(points: PointPort, userId: string, now: Date): Promise<void> {
  const affected = await points.insertPointBalanceOnConflictDoNothing({
    userId,
    balance: INITIAL_POINT_BALANCE,
    createdAt: now,
    updatedAt: now,
  });
  if (affected > 0) {
    await points.insertPointTransactionOnConflictDoNothing({
      id: crypto.randomUUID(),
      userId,
      amount: INITIAL_POINT_BALANCE,
      type: "initial_grant",
      balanceAfter: INITIAL_POINT_BALANCE,
      idempotencyKey: `initial:${userId}`,
      usageLogId: null,
      createdAt: now,
    });
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
  points: PointPort,
  userId: string,
  model: string
): Promise<PointReservation | null> {
  if (!userId) return { userId, model, amount: 0, debitId: "" };
  const reservation: PointReservation = {
    userId,
    model,
    amount: ROAMING_MINIMUM_POINTS,
    debitId: crypto.randomUUID(),
  };
  const now = new Date();
  return points.transaction(async (tx) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.promise(() => ensurePointBalance(tx, userId, now));
        const balanceAfter = yield* Effect.promise(() =>
          tx.debitPointBalance({ userId, amount: reservation.amount, at: now })
        );
        if (balanceAfter === null) return null;
        yield* Effect.promise(() =>
          tx.insertPointTransaction({
            id: reservation.debitId,
            userId,
            amount: -reservation.amount,
            type: "roaming_debit",
            balanceAfter,
            idempotencyKey: null,
            usageLogId: null,
            createdAt: now,
          })
        );
        return reservation;
      })
    )
  );
}

export async function refundRoamingPoint(points: PointPort, reservation: PointReservation | null): Promise<void> {
  if (!reservation || !reservation.userId || reservation.amount <= 0) return;
  const now = new Date();
  const idempotencyKey = `roaming_refund:${reservation.debitId}`;
  await points.transaction(async (tx) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.promise(() => ensurePointBalance(tx, reservation.userId, now));
        const transactionId = crypto.randomUUID();
        const affected = yield* Effect.promise(() =>
          tx.insertPointTransactionOnConflictDoNothing({
            id: transactionId,
            userId: reservation.userId,
            amount: reservation.amount,
            type: "roaming_refund",
            balanceAfter: 0,
            idempotencyKey,
            usageLogId: null,
            createdAt: now,
          })
        );
        if (affected === 0) return;
        const balanceAfter = yield* Effect.promise(() =>
          tx.creditPointBalance({ userId: reservation.userId, amount: reservation.amount, at: now })
        );
        yield* Effect.promise(() =>
          tx.updatePointTransactionBalance({ id: transactionId, balanceAfter: balanceAfter ?? 0 })
        );
      })
    )
  );
}

export async function adjustRoamingPoints(
  points: PointPort,
  reservation: PointReservation | null,
  amount: number
): Promise<void> {
  if (!reservation || !reservation.userId) return;
  const delta = amount - reservation.amount;
  const now = new Date();
  const idempotencyKey = `roaming_settle:${reservation.debitId}`;
  await points.transaction(async (tx) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.promise(() => ensurePointBalance(tx, reservation.userId, now));
        const transactionId = crypto.randomUUID();
        const affected = yield* Effect.promise(() =>
          tx.insertPointTransactionOnConflictDoNothing({
            id: transactionId,
            userId: reservation.userId,
            amount: -delta,
            type: "roaming_settle",
            balanceAfter: 0,
            idempotencyKey,
            usageLogId: null,
            createdAt: now,
          })
        );
        if (affected === 0) return;
        if (delta === 0) return;
        const balanceAfter = yield* Effect.promise(() =>
          delta > 0
            ? tx.debitPointBalanceAllowNegative({ userId: reservation.userId, amount: delta, at: now })
            : tx.creditPointBalance({ userId: reservation.userId, amount: -delta, at: now })
        );
        yield* Effect.promise(() =>
          tx.updatePointTransactionBalance({ id: transactionId, balanceAfter: balanceAfter ?? 0 })
        );
      })
    )
  );
}

export async function settleRoamingPoint(
  points: PointPort,
  registry: Registry | null,
  ownerUserId: string,
  reservation: PointReservation | null,
  model: string,
  usage: UsageCounts | null
): Promise<void> {
  if (!reservation) return;
  const amount = roamingPoints(registry, model, usage);
  await adjustRoamingPoints(points, reservation, amount);
  await creditSharingPoint(points, ownerUserId, reservation.debitId, amount);
}

export async function creditSharingPoint(
  points: PointPort,
  ownerUserId: string,
  debitId: string,
  amount: number
): Promise<void> {
  if (!ownerUserId || !debitId || amount <= 0) return;
  const now = new Date();
  const idempotencyKey = `sharing_credit:${debitId}`;
  await points.transaction(async (tx) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.promise(() => ensurePointBalance(tx, ownerUserId, now));
        const transactionId = crypto.randomUUID();
        const affected = yield* Effect.promise(() =>
          tx.insertPointTransactionOnConflictDoNothing({
            id: transactionId,
            userId: ownerUserId,
            amount,
            type: "sharing_credit",
            balanceAfter: 0,
            idempotencyKey,
            usageLogId: null,
            createdAt: now,
          })
        );
        if (affected === 0) return;
        const balanceAfter = yield* Effect.promise(() =>
          tx.creditPointBalance({ userId: ownerUserId, amount, at: now })
        );
        yield* Effect.promise(() =>
          tx.updatePointTransactionBalance({ id: transactionId, balanceAfter: balanceAfter ?? 0 })
        );
      })
    )
  );
}

export async function ensureUserPointBalance(points: PointPort, userId: string): Promise<void> {
  await ensurePointBalance(points, userId, new Date());
}
