import { Effect, Schedule } from "effect";
import type { DatabaseFailure } from "@opendum/database";
import { refundRoamingPoint, type PointReservation } from "@opendum/api/core/points";
import type { PointPort } from "@opendum/api/core/repositories";

export const ORPHAN_AGE_MS = 15 * 60 * 1000;
export const ROAMING_RECONCILE_BATCH = 200;
const ROAMING_RECONCILE_CONCURRENCY = 8;

export type ReconcileOptions = {
  olderThanMs?: number;
  batchLimit?: number;
  now?: Date;
};

export type ReconcileResult = {
  scanned: number;
  refunded: number;
  failed: number;
};

export function reconcileOrphans(
  points: PointPort,
  options: ReconcileOptions = {}
): Effect.Effect<ReconcileResult, DatabaseFailure> {
  const now = options.now ?? new Date();
  const olderThanMs = options.olderThanMs ?? ORPHAN_AGE_MS;
  const batchLimit = options.batchLimit ?? ROAMING_RECONCILE_BATCH;
  return Effect.gen(function* () {
    const orphans = yield* points.listOrphaned({
      olderThan: new Date(now.getTime() - olderThanMs),
      limit: batchLimit,
    });

    const outcomes = yield* Effect.forEach(
      orphans,
      (orphan) => {
        const reservation: PointReservation = {
          userId: orphan.userId,
          model: "",
          amount: Math.abs(orphan.amount),
          debitId: orphan.id,
        };
        return refundRoamingPoint(points, reservation).pipe(
          Effect.tapError((error) =>
            Effect.logError("roaming refund failed", { debitId: orphan.id, error: error.message })
          ),
          Effect.as(true),
          Effect.orElseSucceed(() => false)
        );
      },
      { concurrency: ROAMING_RECONCILE_CONCURRENCY }
    );

    const refunded = outcomes.filter(Boolean).length;
    return { scanned: orphans.length, refunded, failed: orphans.length - refunded };
  });
}

export function reconcileLoop(
  intervalMs: number,
  run: () => Effect.Effect<ReconcileResult, DatabaseFailure>
): Effect.Effect<void, never> {
  if (intervalMs <= 0) return Effect.void;
  return Effect.repeat(
    Effect.suspend(run).pipe(
      Effect.tap((result) =>
        result.refunded > 0 || result.failed > 0
          ? Effect.logWarning("roaming reconciliation", result)
          : Effect.void
      ),
      Effect.catchCause((cause) => Effect.logError("roaming reconciliation failed", { cause })),
      Effect.asVoid
    ),
    Schedule.spaced(intervalMs)
  ).pipe(Effect.asVoid);
}
