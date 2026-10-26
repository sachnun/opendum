import { expect, test } from "bun:test";

import { dayKeys, emptyStats, hourKeys } from "./stats.ts";

test("dayKeys returns ascending UTC day keys ending today", () => {
  const keys = dayKeys(3);
  expect(keys.length).toBe(3);
  expect(keys[0]! < keys[1]! && keys[1]! < keys[2]!).toBeTruthy();
  expect(keys[2]).toBe(new Date().toISOString().split("T")[0]);
  for (const key of keys) {
    expect(key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  }
});

test("dayKeys handles non-positive day counts", () => {
  expect(dayKeys(0)).toEqual([]);
  expect(dayKeys(-1)).toEqual([]);
});

test("hourKeys returns ascending UTC hour keys ending at the current hour", () => {
  const keys = hourKeys(3);
  expect(keys.length).toBe(3);
  expect(keys[0]! < keys[1]! && keys[1]! < keys[2]!).toBeTruthy();
  for (const key of keys) {
    expect(key.endsWith(":00:00.000Z"), `hour key ${key} is not aligned to the hour`).toBeTruthy();
    expect(!Number.isNaN(new Date(key).getTime())).toBeTruthy();
  }
});

test("emptyStats returns a neutral stats object", () => {
  const stats = emptyStats(dayKeys(2), hourKeys(2));
  expect(stats).toEqual({
    totalRequests: 0,
    totalTokens: 0,
    successRate: null,
    dailyRequests: [],
    avgDurationLastDay: null,
    durationLast24Hours: [],
  });
});
