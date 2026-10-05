import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import type { Database } from "@opendum/database";
import type { Registry } from "@opendum/models/runtime";
import type { OpendumRedis } from "@opendum/redis";

const db = vi.hoisted(() => ({
  creditPointBalance: vi.fn(async (): Promise<number | null> => 0),
  debitPointBalance: vi.fn(async (): Promise<number | null> => 0),
  debitPointBalanceAllowNegative: vi.fn(async (): Promise<number | null> => 0),
  insertPointBalanceOnConflictDoNothing: vi.fn(async () => 0),
  insertPointTransaction: vi.fn(async () => undefined),
  insertPointTransactionOnConflictDoNothing: vi.fn(async () => 0),
  updatePointTransactionBalance: vi.fn(async () => undefined),
}));

vi.mock("@opendum/database/queries", () => db);

import {
  adjustRoamingPoints,
  creditSharingPoint,
  ensureUserPointBalance,
  refundRoamingPoint,
  reserveRoamingPoint,
  roamingPoints,
  settleRoamingPoint,
} from "../src/core/points.js";
import {
  anySlice,
  cloneMap,
  cloneMapExcept,
  defaultStringValue,
  mapSlice,
  numberAsFloat,
  numberAsInt,
  sleep,
  stringValue,
} from "../src/core/helpers.js";
import { stripImageContent } from "../src/core/content.js";
import {
  errorHistoryDedupeKey,
  errorHistoryEntryKey,
  errorHistoryKey,
  errorHistoryTtl,
  upsertErrorHistory,
} from "../src/core/error-history.js";

function fakeDatabase(): Database {
  return {
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({})),
  } as unknown as Database;
}

function fakeRegistry(cost: Record<string, number> | null): Registry {
  return { modelCost: () => cost } as unknown as Registry;
}

describe("proxy helpers", () => {
  it("coerces primitives", () => {
    assert.equal(stringValue("x"), "x");
    assert.equal(stringValue(1), "");
    assert.equal(defaultStringValue("", "fb"), "fb");
    assert.equal(defaultStringValue("v", "fb"), "v");
    assert.equal(numberAsInt("3.9"), 3);
    assert.equal(numberAsInt("nope"), 0);
    assert.equal(numberAsFloat("2.5"), 2.5);
    assert.equal(numberAsFloat(null), 0);
  });

  it("clones records", () => {
    assert.deepEqual(cloneMap({ a: 1 }), { a: 1 });
    assert.deepEqual(cloneMapExcept({ a: 1, b: 2 }, "b"), { a: 1 });
  });

  it("slices arrays and object arrays", () => {
    assert.deepEqual(anySlice([1, 2]), [1, 2]);
    assert.deepEqual(anySlice("x"), []);
    assert.deepEqual(mapSlice([{ a: 1 }, null, 2, []]), [{ a: 1 }]);
  });

  it("sleeps and aborts", async () => {
    await sleep(1);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(sleep(1000, controller.signal), /aborted/);
    const controller2 = new AbortController();
    const pending = sleep(1000, controller2.signal);
    controller2.abort();
    await assert.rejects(pending, /aborted/);
  });
});

describe("stripImageContent", () => {
  it("removes image parts and collapses single text parts", () => {
    const payload: Record<string, unknown> = {
      messages: [
        { content: [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: "x" } }] },
        { content: [{ type: "text", text: "only" }] },
        { content: "plain" },
      ],
      _responsesInput: [{ content: [{ type: "input_image", image_url: "x" }, { type: "input_text", text: "t" }] }],
    };
    stripImageContent(payload);
    const messages = payload.messages as Array<Record<string, unknown>>;
    assert.equal(messages[0]!.content, "hi");
    assert.equal(messages[1]!.content, "only");
    assert.equal(messages[2]!.content, "plain");
    const input = (payload._responsesInput as Array<Record<string, unknown>>)[0]!;
    assert.deepEqual(input.content, [{ type: "input_text", text: "t" }]);
  });

  it("ignores payloads without message arrays", () => {
    const payload: Record<string, unknown> = { messages: "nope" };
    stripImageContent(payload);
    assert.equal(payload.messages, "nope");
  });

  it("skips non-array content and keeps primitive parts", () => {
    const payload: Record<string, unknown> = {
      messages: [{ content: "plain" }, { content: [{ type: "image_url", image_url: { url: "x" } }, "raw", null, [1]] }],
      _responsesInput: [{ noContent: true }, { content: ["raw", { type: "input_image", image_url: "x" }] }],
    };
    stripImageContent(payload);
    const messages = payload.messages as Array<Record<string, unknown>>;
    assert.equal(messages[0]!.content, "plain");
    assert.deepEqual(messages[1]!.content, ["raw", null, [1]]);
    const input = (payload._responsesInput as Array<Record<string, unknown>>)[1]!;
    assert.deepEqual(input.content, ["raw"]);
  });
});

describe("roamingPoints", () => {
  it("returns the minimum when there is no cost data", () => {
    assert.equal(roamingPoints(null, "m", null), 1);
    assert.equal(roamingPoints(fakeRegistry(null), "m", { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 }), 1);
  });

  it("computes points from usage and cost", () => {
    const registry = fakeRegistry({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });
    const points = roamingPoints(registry, "m", {
      inputTokens: 2_000_000,
      outputTokens: 500_000,
      cachedTokens: 1_000_000,
      cacheWriteTokens: 250_000,
    });
    assert.equal(points, 6);
  });
});

describe("point reservations", () => {
  it("reserves points inside a transaction", async () => {
    db.debitPointBalance.mockResolvedValueOnce(9);
    const reservation = await reserveRoamingPoint(fakeDatabase(), "u", "m");
    assert.equal(reservation?.amount, 1);
    assert.equal(reservation?.userId, "u");
    assert.ok(reservation?.debitId);
  });

  it("returns null when the balance is insufficient", async () => {
    db.debitPointBalance.mockResolvedValueOnce(null);
    assert.equal(await reserveRoamingPoint(fakeDatabase(), "u", "m"), null);
  });

  it("short-circuits for empty users", async () => {
    assert.deepEqual(await reserveRoamingPoint(fakeDatabase(), "", "m"), { userId: "", model: "m", amount: 0, debitId: "" });
  });

  it("ensures balances and grants initial points", async () => {
    db.insertPointBalanceOnConflictDoNothing.mockResolvedValueOnce(1);
    await ensureUserPointBalance(fakeDatabase(), "u");
    assert.equal(db.insertPointTransactionOnConflictDoNothing.mock.calls.length > 0, true);
  });

  it("refunds reservations", async () => {
    db.insertPointTransactionOnConflictDoNothing.mockResolvedValueOnce(1);
    db.creditPointBalance.mockResolvedValueOnce(11);
    await refundRoamingPoint(fakeDatabase(), { userId: "u", model: "m", amount: 1, debitId: "d1" });
    assert.equal(db.creditPointBalance.mock.calls.length > 0, true);

    db.insertPointTransactionOnConflictDoNothing.mockResolvedValueOnce(0);
    await refundRoamingPoint(fakeDatabase(), { userId: "u", model: "m", amount: 1, debitId: "d1" });

    await refundRoamingPoint(fakeDatabase(), null);
    await refundRoamingPoint(fakeDatabase(), { userId: "", model: "m", amount: 1, debitId: "d" });
  });

  it("adjusts reservations up and down", async () => {
    db.insertPointTransactionOnConflictDoNothing.mockResolvedValueOnce(1);
    db.debitPointBalanceAllowNegative.mockResolvedValueOnce(8);
    await adjustRoamingPoints(fakeDatabase(), { userId: "u", model: "m", amount: 1, debitId: "d1" }, 5);
    assert.equal(db.debitPointBalanceAllowNegative.mock.calls.length > 0, true);

    db.insertPointTransactionOnConflictDoNothing.mockResolvedValueOnce(1);
    db.creditPointBalance.mockResolvedValueOnce(20);
    await adjustRoamingPoints(fakeDatabase(), { userId: "u", model: "m", amount: 5, debitId: "d2" }, 1);

    await adjustRoamingPoints(fakeDatabase(), null, 5);
    await adjustRoamingPoints(fakeDatabase(), { userId: "u", model: "m", amount: 3, debitId: "d3" }, 3);

    db.insertPointTransactionOnConflictDoNothing.mockResolvedValueOnce(0);
    await adjustRoamingPoints(fakeDatabase(), { userId: "u", model: "m", amount: 1, debitId: "d4" }, 4);
  });

  it("settles and credits sharing points", async () => {
    await settleRoamingPoint(fakeDatabase(), null, "owner", null, "m", null);

    db.insertPointTransactionOnConflictDoNothing.mockResolvedValue(1);
    db.creditPointBalance.mockResolvedValue(5);
    await creditSharingPoint(fakeDatabase(), "owner", "d1", 2);
    await creditSharingPoint(fakeDatabase(), "", "d1", 2);
    await creditSharingPoint(fakeDatabase(), "owner", "", 2);
    await creditSharingPoint(fakeDatabase(), "owner", "d1", 0);

    db.insertPointTransactionOnConflictDoNothing.mockResolvedValue(0);
    await creditSharingPoint(fakeDatabase(), "owner", "d2", 2);

    db.insertPointTransactionOnConflictDoNothing.mockResolvedValue(1);
    await settleRoamingPoint(fakeDatabase(), fakeRegistry({ input: 1 }), "owner", { userId: "u", model: "m", amount: 1, debitId: "d5" }, "m", { inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 });
    assert.equal(db.creditPointBalance.mock.calls.length > 0, true);
  });
});

describe("error history", () => {
  it("computes ttl and keys", () => {
    assert.equal(errorHistoryTtl(429), 3 * 24 * 60 * 60);
    assert.equal(errorHistoryTtl(500), 14 * 24 * 60 * 60);
    assert.match(errorHistoryKey("a"), /:a$/);
    assert.match(errorHistoryEntryKey("e"), /:e$/);
    assert.match(errorHistoryDedupeKey("a", null, 500, "boom"), /^opendum:provider-account:error-history-dedupe:a:/);
  });

  it("skips without redis", async () => {
    await upsertErrorHistory(null, "a", "u", null, 500, "boom", new Date());
  });

  it("writes entries with dedupe and catches failures", async () => {
    const store = new Map<string, string>();
    const getMock = vi.fn(async (key: string) => store.get(key) ?? null);
    const setMock = vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    });
    const zAddMock = vi.fn(async () => 1);
    const redis = {
      get: getMock,
      set: setMock,
      zAdd: zAddMock,
      expire: vi.fn(async () => 1),
    } as unknown as OpendumRedis;

    await upsertErrorHistory(redis, "a", "u", "m", 429, "rate limited", new Date("2026-01-01T00:00:00Z"));
    assert.equal(setMock.mock.calls.length, 2);
    assert.equal(zAddMock.mock.calls.length, 1);

    const dedupeKey = errorHistoryDedupeKey("a", "m", 429, "rate limited");
    store.set(dedupeKey, "existing-id");
    await upsertErrorHistory(redis, "a", "u", "m", 429, "rate limited", new Date());

    const brokenGet = {
      get: vi.fn(async () => {
        throw new Error("down");
      }),
      set: vi.fn(async () => undefined),
      zAdd: vi.fn(async () => 1),
      expire: vi.fn(async () => 1),
    } as unknown as OpendumRedis;
    await upsertErrorHistory(brokenGet, "a", "u", null, 500, "boom", new Date());

    const brokenSet = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => {
        throw new Error("down");
      }),
      zAdd: vi.fn(async () => 1),
      expire: vi.fn(async () => 1),
    } as unknown as OpendumRedis;
    await upsertErrorHistory(brokenSet, "a", "u", null, 500, "boom", new Date());
  });
});
