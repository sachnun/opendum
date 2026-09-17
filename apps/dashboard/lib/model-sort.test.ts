import { test } from "node:test";
import assert from "node:assert/strict";

import { MODEL_FAMILY_SORT_ORDER } from "./model-families";
import { compareModelEntries, compareModelIds } from "./model-sort";

const FEATURED_FAMILIES = MODEL_FAMILY_SORT_ORDER.filter((family) => family !== "Others");
const TOP_FAMILY = FEATURED_FAMILIES[0]!;
const NEXT_FAMILY = FEATURED_FAMILIES[1] ?? TOP_FAMILY;

const entry = (id: string, family?: string) => ({ id, family });

test("featured families sort before the Others bucket", () => {
  assert.ok(compareModelEntries(entry("mock-a", TOP_FAMILY), entry("mock-b")) < 0);
  assert.ok(compareModelEntries(entry("mock-b"), entry("mock-a", TOP_FAMILY)) > 0);
});

test("higher ranked families sort first", () => {
  if (TOP_FAMILY === NEXT_FAMILY) return;
  assert.ok(compareModelEntries(entry("mock-a", TOP_FAMILY), entry("mock-b", NEXT_FAMILY)) < 0);
});

test("claude tiers order opus before sonnet before haiku", () => {
  const sorted = ["mock-haiku", "mock-opus", "mock-sonnet"].sort((left, right) =>
    compareModelEntries(entry(left, "Anthropic"), entry(right, "Anthropic")),
  );
  assert.deepEqual(sorted, ["mock-opus", "mock-sonnet", "mock-haiku"]);
});

test("newer claude versions sort first", () => {
  const sorted = ["mock-opus-4-5", "mock-opus-4-6"].sort((left, right) =>
    compareModelEntries(entry(left, "Anthropic"), entry(right, "Anthropic")),
  );
  assert.deepEqual(sorted, ["mock-opus-4-6", "mock-opus-4-5"]);
});

test("newer gpt versions sort first", () => {
  const sorted = ["gpt-9", "gpt-10"].sort(compareModelIds);
  assert.deepEqual(sorted, ["gpt-10", "gpt-9"]);
});

test("object entries use the declared family for ranking", () => {
  assert.ok(compareModelEntries(entry("mock-z", TOP_FAMILY), entry("mock-a", NEXT_FAMILY)) < 0);
});
