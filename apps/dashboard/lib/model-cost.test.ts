import { test } from "node:test";
import assert from "node:assert/strict";

import { MODEL_COST_FIELDS, costEntries, formatCostPoints } from "./model-cost";

test("MODEL_COST_FIELDS covers every cost dimension", () => {
  assert.deepEqual(
    MODEL_COST_FIELDS.map((field) => field.key),
    ["input", "output", "cacheRead", "cacheWrite"],
  );
});

test("costEntries keeps zero values and drops missing fields", () => {
  assert.deepEqual(costEntries({ input: 0, cacheWrite: 3 }), [
    { label: "Input", value: 0 },
    { label: "Cache write", value: 3 },
  ]);
  assert.deepEqual(costEntries({}), []);
});

test("costEntries preserves declared field order", () => {
  assert.deepEqual(costEntries({ cacheRead: 1, input: 2, output: 3 }), [
    { label: "Input", value: 2 },
    { label: "Output", value: 3 },
    { label: "Cache read", value: 1 },
  ]);
});

test("formatCostPoints formats with at most three fraction digits", () => {
  assert.equal(formatCostPoints(1), "1");
  assert.equal(formatCostPoints(1234.5), "1,234.5");
  assert.equal(formatCostPoints(1.23456), "1.235");
});
