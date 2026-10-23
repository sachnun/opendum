import { Effect, Schedule } from "effect";
import { refundRoamingPoint, type PointReservation } from "./points.js";
import type { PointPort } from "./repositories.js";

export const ROAMING_ORPHAN_AGE_MS = 15 * 60 * 1000;
export const ROAMING_RECONCILE_BATCH = 200;

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

/**
 * Refunds roaming reservations whose settle or refund never landed because the
 * process died mid-stream. A request older than the grace window can no longer
 * be in flight, so the debit is safe to reverse.
 */
export async function reconcileOrphanedRoaming(
  points: PointPort,
  options: ReconcileOptions = {}
): Promise<ReconcileResult> {
  const now = options.now ?? new Date();
  const olderThanMs = options.olderThanMs ?? ROAMING_ORPHAN_AGE_MS;
  const batchLimit = options.batchLimit ?? ROAMING_RECONCILE_BATCH;
  const orphans = await points.listOrphanedRoamingDebits({
    olderThan: new Date(now.getTime() - olderThanMs),
    limit: batchLimit,
  });

  let refunded = 0;
  let failed = 0;
  for (const orphan of orphans) {
    const reservation: PointReservation = {
      userId: orphan.userId,
      model: "",
      amount: Math.abs(orphan.amount),
      debitId: orphan.id,
    };
    const outcome = await Effect.runPromise(
      Effect.tryPromise({
        try: () => refundRoamingPoint(points, reservation),
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      }).pipe(Effect.result)
    );
    if (outcome._tag === "Success") refunded += 1;
    else failed += 1;
  }

  return { scanned: orphans.length, refunded, failed };
}

export function roamingReconcileLoop(
  intervalMs: number,
  run: () => Promise<ReconcileResult>
): Effect.Effect<void, never> {
  if (intervalMs <= 0) return Effect.void;
  return Effect.repeat(
    Effect.promise(run).pipe(
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
