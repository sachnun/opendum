import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import type { RateLimitRule } from "@opendum/auth";
import type { Registry } from "@opendum/models/runtime";
import type { OpendumRedis } from "@opendum/redis";
import {
  apiKeyWindowKey,
  checkAndIncrementAPIKeyRateLimit,
  matchRateLimitRule,
  windowBucket,
} from "../src/core/metering/ratelimit.ts";

function registry(families: Record<string, string> = {}): Registry {
  return { modelFamily: (model: string) => families[model] ?? "" } as unknown as Registry;
}

function rule(overrides: Partial<RateLimitRule> = {}): RateLimitRule {
  return { target: "model-x", targetType: "model", perMinute: null, perHour: null, perDay: null, ...overrides };
}

function fakeRedis(values: Record<string, string> = {}): { redis: OpendumRedis; incr: ReturnType<typeof vi.fn>; expire: ReturnType<typeof vi.fn> } {
  let counter = 0;
  const incr = vi.fn(async (key: string) => {
    const existing = values[key] ? Number.parseInt(values[key], 10) : 0;
    counter = existing + 1;
    values[key] = String(counter);
    return counter;
  });
  const expire = vi.fn(async () => 1);
  const redis = {
    get: vi.fn(async (key: string) => values[key] ?? null),
    incr,
    expire,
  } as unknown as OpendumRedis;
  return { redis, incr, expire };
}

describe("matchRateLimitRule", () => {
  it("matches model, alias and family rules", () => {
    const modelRule = rule({ target: "model-x" });
    assert.equal(matchRateLimitRule(registry(), "model-x", "alias-x", [modelRule]), modelRule);
    assert.equal(matchRateLimitRule(registry(), "m", "alias-x", [rule({ target: "alias-x" })])?.target, "alias-x");

    const rules = [rule({ target: "claude", targetType: "family" })];
    assert.equal(matchRateLimitRule(registry({ "model-x": "claude" }), "model-x", "", rules), rules[0]);
    assert.equal(matchRateLimitRule(registry({ alias: "claude" }), "model-x", "alias", rules), rules[0]);
    assert.equal(matchRateLimitRule(registry(), "model-x", "", rules), null);
  });
});

describe("window helpers", () => {
  it("buckets windows and builds keys", () => {
    assert.equal(windowBucket(60) % 60, 0);
    assert.match(apiKeyWindowKey("k1", "model-x", "min", 60), /^opendum:api-key-rl:k1:model-x:min:/);
  });
});

describe("checkAndIncrementAPIKeyRateLimit", () => {
  it("allows requests without a matching rule", async () => {
    const { redis } = fakeRedis();
    const result = await checkAndIncrementAPIKeyRateLimit(redis, registry(), "k1", "m", "", []);
    assert.deepEqual(result, { allowed: true, retryAfterSeconds: 0, exceededWindow: "", limit: 0, current: 0 });
  });

  it("allows requests without any limits", async () => {
    const { redis } = fakeRedis();
    const result = await checkAndIncrementAPIKeyRateLimit(redis, registry(), "k1", "model-x", "", [rule()]);
    assert.equal(result.allowed, true);
  });

  it("increments counters within limits", async () => {
    const { redis, incr, expire } = fakeRedis();
    const result = await checkAndIncrementAPIKeyRateLimit(redis, registry(), "k1", "model-x", "", [
      rule({ perMinute: 5, perHour: 10 }),
    ]);
    assert.equal(result.allowed, true);
    assert.equal(incr.mock.calls.length, 2);
    assert.equal(expire.mock.calls.length, 2);
  });

  it("reports exceeded windows", async () => {
    const bucket = windowBucket(60);
    const { redis } = fakeRedis({ [`opendum:api-key-rl:k1:model-x:min:${bucket}`]: "5" });
    const result = await checkAndIncrementAPIKeyRateLimit(redis, registry(), "k1", "model-x", "", [rule({ perMinute: 5, perDay: 10 })]);
    assert.equal(result.allowed, false);
    assert.equal(result.exceededWindow, "minute");
    assert.equal(result.limit, 5);
    assert.equal(result.current, 5);
    assert.ok(result.retryAfterSeconds >= 1);
  });
});
