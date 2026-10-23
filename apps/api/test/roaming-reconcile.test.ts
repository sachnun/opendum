import { describe, expect, it, mock } from "bun:test";
import { Effect } from "effect";

import type { PointPort } from "../core/repositories.js";
import { reconcileOrphanedRoaming, ROAMING_ORPHAN_AGE_MS } from "../core/roaming-reconcile.js";
import { fakes } from "./fakes.js";

function pointPort(overrides: Partial<PointPort> = {}): PointPort {
  const base = fakes().points;
  const port = { ...base, ...overrides } as PointPort;
  port.transaction = (run) => run(port);
  return port;
}

describe("roaming reconciliation", () => {
  it("refunds every orphaned debit", async () => {
    const points = pointPort({
      listOrphanedRoamingDebits: async () => [
        { id: "debit-1", userId: "user-1", amount: -1, createdAt: new Date(0) },
        { id: "debit-2", userId: "user-2", amount: -3, createdAt: new Date(0) },
      ],
      insertPointTransactionOnConflictDoNothing: mock(async () => 1),
    });

    const result = await Effect.runPromise(reconcileOrphanedRoaming(points, { now: new Date() }));

    expect(result).toEqual({ scanned: 2, refunded: 2, failed: 0 });
    expect(points.insertPointTransactionOnConflictDoNothing).toHaveBeenCalledTimes(2);
    expect(points.creditPointBalance).toHaveBeenCalledTimes(2);
  });

  it("queries debits older than the grace window", async () => {
    const now = new Date("2025-01-01T12:00:00.000Z");
    const calls: Array<{ olderThan: Date; limit: number }> = [];
    const points = pointPort({
      listOrphanedRoamingDebits: async (params) => {
        calls.push(params);
        return [];
      },
    });

    await Effect.runPromise(reconcileOrphanedRoaming(points, { now, batchLimit: 7 }));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.limit).toBe(7);
    expect(calls[0]?.olderThan.getTime()).toBe(now.getTime() - ROAMING_ORPHAN_AGE_MS);
  });

  it("counts a refund failure without aborting the batch", async () => {
    const points = pointPort({
      listOrphanedRoamingDebits: async () => [
        { id: "debit-1", userId: "user-1", amount: -1, createdAt: new Date(0) },
        { id: "debit-2", userId: "user-2", amount: -1, createdAt: new Date(0) },
      ],
      insertPointTransactionOnConflictDoNothing: mock(async () => {
        throw new Error("database is down");
      }),
    });

    const result = await Effect.runPromise(reconcileOrphanedRoaming(points, { now: new Date() }));

    expect(result).toEqual({ scanned: 2, refunded: 0, failed: 2 });
  });

  it("does nothing when no debit is orphaned", async () => {
    const points = pointPort();

    const result = await Effect.runPromise(reconcileOrphanedRoaming(points, { now: new Date() }));

    expect(result).toEqual({ scanned: 0, refunded: 0, failed: 0 });
    expect(points.creditPointBalance).not.toHaveBeenCalled();
  });
});
