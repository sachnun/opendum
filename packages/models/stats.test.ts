import { expect, test } from "bun:test";

import { buildDayKeys, buildEmptyModelStats, buildHourKeys } from "./stats.ts";

test("buildDayKeys returns ascending UTC day keys ending today", () => {
  const keys = buildDayKeys(3);
  expect(keys.length).toBe(3);
  expect(keys[0]! < keys[1]! && keys[1]! < keys[2]!).toBeTruthy();
  expect(keys[2]).toBe(new Date().toISOString().split("T")[0]);
  for (const key of keys) {
    expect(key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  }
});

test("buildDayKeys handles non-positive day counts", () => {
  expect(buildDayKeys(0)).toEqual([]);
  expect(buildDayKeys(-1)).toEqual([]);
});

test("buildHourKeys returns ascending UTC hour keys ending at the current hour", () => {
  const keys = buildHourKeys(3);
  expect(keys.length).toBe(3);
  expect(keys[0]! < keys[1]! && keys[1]! < keys[2]!).toBeTruthy();
  for (const key of keys) {
    expect(key.endsWith(":00:00.000Z"), `hour key ${key} is not aligned to the hour`).toBeTruthy();
    expect(!Number.isNaN(new Date(key).getTime())).toBeTruthy();
  }
});

test("buildEmptyModelStats returns a neutral stats object", () => {
  const stats = buildEmptyModelStats(buildDayKeys(2), buildHourKeys(2));
  expect(stats).toEqual({
    totalRequests: 0,
    totalTokens: 0,
    successRate: null,
    dailyRequests: [],
    avgDurationLastDay: null,
    durationLast24Hours: [],
  });
});
