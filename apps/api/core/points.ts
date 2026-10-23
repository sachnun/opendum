import { Effect } from "effect";
import type { DatabaseFailure } from "@opendum/database";
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

const ensurePointBalance = Effect.fn("points.ensureBalance")(function* (
  points: PointPort,
  userId: string,
  now: Date
) {
  const affected = yield* points.insertPointBalanceOnConflictDoNothing({
    userId,
    balance: INITIAL_POINT_BALANCE,
    createdAt: now,
    updatedAt: now,
  });
  if (affected > 0) {
    yield* points.insertPointTransactionOnConflictDoNothing({
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
});

export function roamingPoints(
  registry: Registry | null,
  model: string,
  usage: UsageCounts | null
): number {
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

export const reserveRoamingPoint = Effect.fn("points.reserveRoaming")(function* (
  points: PointPort,
  userId: string,
  model: string
) {
  if (!userId) return { userId, model, amount: 0, debitId: "" } satisfies PointReservation;
  const reservation: PointReservation = {
    userId,
    model,
    amount: ROAMING_MINIMUM_POINTS,
    debitId: crypto.randomUUID(),
  };
  const now = new Date();
  return yield* points.transaction((tx): Effect.Effect<PointReservation | null, DatabaseFailure> =>
    Effect.gen(function* () {
      yield* ensurePointBalance(tx, userId, now);
      const balanceAfter = yield* tx.debitPointBalance({
        userId,
        amount: reservation.amount,
        at: now,
      });
      if (balanceAfter === null) return null as PointReservation | null;
      yield* tx.insertPointTransaction({
        id: reservation.debitId,
        userId,
        amount: -reservation.amount,
        type: "roaming_debit",
        balanceAfter,
        idempotencyKey: null,
        usageLogId: null,
        createdAt: now,
      });
      return reservation as PointReservation | null;
    })
  );
});

export const refundRoamingPoint = Effect.fn("points.refundRoaming")(function* (
  points: PointPort,
  reservation: PointReservation | null
) {
  if (!reservation || !reservation.userId || reservation.amount <= 0) return;
  const now = new Date();
  const idempotencyKey = `roaming_refund:${reservation.debitId}`;
  yield* points.transaction((tx): Effect.Effect<void, DatabaseFailure> =>
    Effect.gen(function* () {
      yield* ensurePointBalance(tx, reservation.userId, now);
      const transactionId = crypto.randomUUID();
      const affected = yield* tx.insertPointTransactionOnConflictDoNothing({
        id: transactionId,
        userId: reservation.userId,
        amount: reservation.amount,
        type: "roaming_refund",
        balanceAfter: 0,
        idempotencyKey,
        usageLogId: null,
        createdAt: now,
      });
      if (affected === 0) return;
      const balanceAfter = yield* tx.creditPointBalance({
        userId: reservation.userId,
        amount: reservation.amount,
        at: now,
      });
      yield* tx.updatePointTransactionBalance({ id: transactionId, balanceAfter: balanceAfter ?? 0 });
    })
  );
});

export const adjustRoamingPoints = Effect.fn("points.adjustRoaming")(function* (
  points: PointPort,
  reservation: PointReservation | null,
  amount: number
) {
  if (!reservation || !reservation.userId) return;
  const delta = amount - reservation.amount;
  const now = new Date();
  const idempotencyKey = `roaming_settle:${reservation.debitId}`;
  yield* points.transaction((tx): Effect.Effect<void, DatabaseFailure> =>
    Effect.gen(function* () {
      yield* ensurePointBalance(tx, reservation.userId, now);
      const transactionId = crypto.randomUUID();
      const affected = yield* tx.insertPointTransactionOnConflictDoNothing({
        id: transactionId,
        userId: reservation.userId,
        amount: -delta,
        type: "roaming_settle",
        balanceAfter: 0,
        idempotencyKey,
        usageLogId: null,
        createdAt: now,
      });
      if (affected === 0) return;
      if (delta === 0) return;
      const balanceAfter =
        delta > 0
          ? yield* tx.debitPointBalanceAllowNegative({
              userId: reservation.userId,
              amount: delta,
              at: now,
            })
          : yield* tx.creditPointBalance({ userId: reservation.userId, amount: -delta, at: now });
      yield* tx.updatePointTransactionBalance({ id: transactionId, balanceAfter: balanceAfter ?? 0 });
    })
  );
});

export const settleRoamingPoint = Effect.fn("points.settleRoaming")(function* (
  points: PointPort,
  registry: Registry | null,
  ownerUserId: string,
  reservation: PointReservation | null,
  model: string,
  usage: UsageCounts | null
) {
  if (!reservation) return;
  const amount = roamingPoints(registry, model, usage);
  yield* adjustRoamingPoints(points, reservation, amount);
  yield* creditSharingPoint(points, ownerUserId, reservation.debitId, amount);
});

export const creditSharingPoint = Effect.fn("points.creditSharing")(function* (
  points: PointPort,
  ownerUserId: string,
  debitId: string,
  amount: number
) {
  if (!ownerUserId || !debitId || amount <= 0) return;
  const now = new Date();
  const idempotencyKey = `sharing_credit:${debitId}`;
  yield* points.transaction((tx): Effect.Effect<void, DatabaseFailure> =>
    Effect.gen(function* () {
      yield* ensurePointBalance(tx, ownerUserId, now);
      const transactionId = crypto.randomUUID();
      const affected = yield* tx.insertPointTransactionOnConflictDoNothing({
        id: transactionId,
        userId: ownerUserId,
        amount,
        type: "sharing_credit",
        balanceAfter: 0,
        idempotencyKey,
        usageLogId: null,
        createdAt: now,
      });
      if (affected === 0) return;
      const balanceAfter = yield* tx.creditPointBalance({
        userId: ownerUserId,
        amount,
        at: now,
      });
      yield* tx.updatePointTransactionBalance({ id: transactionId, balanceAfter: balanceAfter ?? 0 });
    })
  );
});

export const ensureUserPointBalance = Effect.fn("points.ensureUserBalance")(function* (
  points: PointPort,
  userId: string
) {
  yield* ensurePointBalance(points, userId, new Date());
});
