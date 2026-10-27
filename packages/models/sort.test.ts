import { expect, test } from "bun:test";

import { SORT_ORDER } from "@opendum/models/ranking";
import { compareEntries, compareIds } from "@opendum/models/sort";

const FEATURED_FAMILIES = SORT_ORDER.filter((family) => family !== "Others");
const TOP_FAMILY = FEATURED_FAMILIES[0] ?? "Others";
const NEXT_FAMILY = FEATURED_FAMILIES[1] ?? TOP_FAMILY;

const entry = (id: string, family?: string) => ({ id, family });

test("featured families sort before the Others bucket", () => {
  expect(compareEntries(entry("mock-a", TOP_FAMILY), entry("mock-b")) < 0).toBeTruthy();
  expect(compareEntries(entry("mock-b"), entry("mock-a", TOP_FAMILY)) > 0).toBeTruthy();
});

test("higher ranked families sort first", () => {
  if (TOP_FAMILY === NEXT_FAMILY) return;
  expect(compareEntries(entry("mock-a", TOP_FAMILY), entry("mock-b", NEXT_FAMILY)) < 0).toBeTruthy();
});

test("claude tiers order opus before sonnet before haiku", () => {
  const sorted = ["mock-haiku", "mock-opus", "mock-sonnet"].sort((left, right) =>
    compareEntries(entry(left, "Anthropic"), entry(right, "Anthropic")),
  );
  expect(sorted).toEqual(["mock-opus", "mock-sonnet", "mock-haiku"]);
});

test("newer claude versions sort first", () => {
  const sorted = ["mock-opus-4-5", "mock-opus-4-6"].sort((left, right) =>
    compareEntries(entry(left, "Anthropic"), entry(right, "Anthropic")),
  );
  expect(sorted).toEqual(["mock-opus-4-6", "mock-opus-4-5"]);
});

test("newer gpt versions sort first", () => {
  const sorted = ["gpt-9", "gpt-10"].sort(compareIds);
  expect(sorted).toEqual(["gpt-10", "gpt-9"]);
});

test("object entries use the declared family for ranking", () => {
  expect(compareEntries(entry("mock-z", TOP_FAMILY), entry("mock-a", NEXT_FAMILY)) < 0).toBeTruthy();
});
