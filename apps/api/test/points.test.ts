import { describe, expect, it, mock } from "bun:test";

import { adjustRoamingPoints, refundRoamingPoint, reserveRoamingPoint } from "../core/points.js";
import type { PointPort } from "../core/repositories.js";
import { fakes } from "./fakes.js";

function pointPort(overrides: Partial<PointPort> = {}): PointPort {
  const port = { ...fakes().points, ...overrides } as PointPort;
  port.transaction = (run) => run(port);
  return port;
}

describe("roaming points", () => {
  it("debits the minimum on reserve", async () => {
    const points = pointPort({
      debitPointBalance: mock(async () => 9),
      insertPointTransactionOnConflictDoNothing: mock(async () => 1),
    });

    const reservation = await reserveRoamingPoint(points, "user-1", "gpt-4o");

    expect(reservation?.amount).toBe(1);
    expect(points.debitPointBalance).toHaveBeenCalledTimes(1);
    expect(points.insertPointTransaction).toHaveBeenCalledTimes(1);
  });

  it("returns null when the balance cannot cover the reservation", async () => {
    const points = pointPort({ debitPointBalance: mock(async () => null as unknown as number) });

    expect(await reserveRoamingPoint(points, "user-1", "gpt-4o")).toBeNull();
    expect(points.insertPointTransaction).not.toHaveBeenCalled();
  });

  it("writes a settle marker even when the delta is zero", async () => {
    const inserted: Array<{ type: string; idempotencyKey: string | null }> = [];
    const points = pointPort({
      insertPointTransactionOnConflictDoNothing: mock(async (params: { type: string; idempotencyKey: string | null }) => {
        inserted.push({ type: params.type, idempotencyKey: params.idempotencyKey });
        return 1;
      }),
    });

    await adjustRoamingPoints(
      points,
      { userId: "user-1", model: "gpt-4o", amount: 1, debitId: "debit-1" },
      1
    );

    expect(inserted).toEqual([{ type: "roaming_settle", idempotencyKey: "roaming_settle:debit-1" }]);
    expect(points.creditPointBalance).not.toHaveBeenCalled();
    expect(points.debitPointBalanceAllowNegative).not.toHaveBeenCalled();
  });

  it("refunds with an idempotency key derived from the debit", async () => {
    const inserted: Array<{ type: string; idempotencyKey: string | null; amount: number }> = [];
    const points = pointPort({
      insertPointTransactionOnConflictDoNothing: mock(
        async (params: { type: string; idempotencyKey: string | null; amount: number }) => {
          inserted.push({ type: params.type, idempotencyKey: params.idempotencyKey, amount: params.amount });
          return 1;
        }
      ),
    });

    await refundRoamingPoint(points, { userId: "user-1", model: "gpt-4o", amount: 3, debitId: "debit-9" });

    expect(inserted).toEqual([{ type: "roaming_refund", idempotencyKey: "roaming_refund:debit-9", amount: 3 }]);
    expect(points.creditPointBalance).toHaveBeenCalledTimes(1);
  });

  it("does not double refund when the marker already exists", async () => {
    const points = pointPort({ insertPointTransactionOnConflictDoNothing: mock(async () => 0) });

    await refundRoamingPoint(points, { userId: "user-1", model: "gpt-4o", amount: 1, debitId: "debit-1" });

    expect(points.creditPointBalance).not.toHaveBeenCalled();
  });
});
