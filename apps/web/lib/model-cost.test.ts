import { expect, test } from "bun:test";

import { MODEL_COST_FIELDS, costEntries, formatCostPoints } from "./model-cost";

test("MODEL_COST_FIELDS covers every cost dimension", () => {
  expect(MODEL_COST_FIELDS.map((field) => field.key)).toEqual(["input", "output", "cacheRead", "cacheWrite"]);
});

test("costEntries keeps zero values and drops missing fields", () => {
  expect(costEntries({ input: 0, cacheWrite: 3 })).toEqual([
    { label: "Input", value: 0 },
    { label: "Cache write", value: 3 },
  ]);
  expect(costEntries({})).toEqual([]);
});

test("costEntries preserves declared field order", () => {
  expect(costEntries({ cacheRead: 1, input: 2, output: 3 })).toEqual([
    { label: "Input", value: 2 },
    { label: "Output", value: 3 },
    { label: "Cache read", value: 1 },
  ]);
});

test("formatCostPoints formats with at most three fraction digits", () => {
  expect(formatCostPoints(1)).toBe("1");
  expect(formatCostPoints(1234.5)).toBe("1,234.5");
  expect(formatCostPoints(1.23456)).toBe("1.235");
});
