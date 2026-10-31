import { describe, expect, it, mock } from "bun:test";
import { Effect } from "effect";

import { adjustRoamingPoints, refundRoamingPoint, reserveRoamingPoint } from "@opendum/api/proxy/points";
import type { PointPort } from "@opendum/api/proxy/repositories";
import { fakes } from "@opendum/api/test/fakes";

function pointPort(overrides: Partial<PointPort> = {}): PointPort {
  const port = { ...fakes().points, ...overrides } as PointPort;
  port.transaction = (run) => run(port);
  return port;
}

describe("roaming points", () => {
  it("debits the minimum on reserve", async () => {
    const points = pointPort({
      debitPointBalance: mock(() => Effect.succeed(9)),
      insertTransaction: mock(() => Effect.succeed(1)),
    });

    const reservation = await Effect.runPromise(reserveRoamingPoint(points, "user-1", "gpt-4o"));

    expect(reservation?.amount).toBe(1);
    expect(points.debitPointBalance).toHaveBeenCalledTimes(1);
    expect(points.insertPointTransaction).toHaveBeenCalledTimes(1);
  });

  it("returns null when the balance cannot cover the reservation", async () => {
    const points = pointPort({
      debitPointBalance: mock(() => Effect.succeed(null as unknown as number)),
    });

    expect(await Effect.runPromise(reserveRoamingPoint(points, "user-1", "gpt-4o"))).toBeNull();
    expect(points.insertPointTransaction).not.toHaveBeenCalled();
  });

  it("writes a settle marker even when the delta is zero", async () => {
    const inserted: Array<{ type: string; idempotencyKey: string | null }> = [];
    const points = pointPort({
      insertTransaction: mock(
        (params: { type: string; idempotencyKey: string | null }) => {
          inserted.push({ type: params.type, idempotencyKey: params.idempotencyKey });
          return Effect.succeed(1);
        }
      ),
    });

    await Effect.runPromise(
      adjustRoamingPoints(
        points,
        { userId: "user-1", model: "gpt-4o", amount: 1, debitId: "debit-1" },
        1
      )
    );

    expect(inserted).toEqual([{ type: "roaming_settle", idempotencyKey: "roaming_settle:debit-1" }]);
    expect(points.creditPointBalance).not.toHaveBeenCalled();
    expect(points.debitAllowNegative).not.toHaveBeenCalled();
  });

  it("refunds with an idempotency key derived from the debit", async () => {
    const inserted: Array<{ type: string; idempotencyKey: string | null; amount: number }> = [];
    const points = pointPort({
      insertTransaction: mock(
        (params: { type: string; idempotencyKey: string | null; amount: number }) => {
          inserted.push({ type: params.type, idempotencyKey: params.idempotencyKey, amount: params.amount });
          return Effect.succeed(1);
        }
      ),
    });

    await Effect.runPromise(
      refundRoamingPoint(points, { userId: "user-1", model: "gpt-4o", amount: 3, debitId: "debit-9" })
    );

    expect(inserted).toEqual([{ type: "roaming_refund", idempotencyKey: "roaming_refund:debit-9", amount: 3 }]);
    expect(points.creditPointBalance).toHaveBeenCalledTimes(1);
  });

  it("does not double refund when the marker already exists", async () => {
    const points = pointPort({
      insertTransaction: mock(() => Effect.succeed(0)),
    });

    await Effect.runPromise(
      refundRoamingPoint(points, { userId: "user-1", model: "gpt-4o", amount: 1, debitId: "debit-1" })
    );

    expect(points.creditPointBalance).not.toHaveBeenCalled();
  });
});
