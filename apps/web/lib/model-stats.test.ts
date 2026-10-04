import { test } from "node:test";
import assert from "node:assert/strict";

import { buildDayKeys, buildEmptyModelStats, buildHourKeys } from "./model-stats";

test("buildDayKeys returns ascending UTC day keys ending today", () => {
  const keys = buildDayKeys(3);
  assert.equal(keys.length, 3);
  assert.ok(keys[0]! < keys[1]! && keys[1]! < keys[2]!);
  assert.equal(keys[2], new Date().toISOString().split("T")[0]);
  for (const key of keys) {
    assert.match(key, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test("buildDayKeys handles non-positive day counts", () => {
  assert.deepEqual(buildDayKeys(0), []);
  assert.deepEqual(buildDayKeys(-1), []);
});

test("buildHourKeys returns ascending UTC hour keys ending at the current hour", () => {
  const keys = buildHourKeys(3);
  assert.equal(keys.length, 3);
  assert.ok(keys[0]! < keys[1]! && keys[1]! < keys[2]!);
  for (const key of keys) {
    assert.ok(key.endsWith(":00:00.000Z"), `hour key ${key} is not aligned to the hour`);
    assert.ok(!Number.isNaN(new Date(key).getTime()));
  }
});

test("buildEmptyModelStats returns a neutral stats object", () => {
  const stats = buildEmptyModelStats(buildDayKeys(2), buildHourKeys(2));
  assert.deepEqual(stats, {
    totalRequests: 0,
    totalTokens: 0,
    successRate: null,
    dailyRequests: [],
    avgDurationLastDay: null,
    durationLast24Hours: [],
  });
});
