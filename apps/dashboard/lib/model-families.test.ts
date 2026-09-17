import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MODEL_FAMILY_NAV_ITEMS,
  MODEL_FAMILY_SORT_ORDER,
  categorizeModelFamily,
  getModelFamilyAnchorId,
} from "./model-families";

const FEATURED_FAMILIES = MODEL_FAMILY_SORT_ORDER.filter((family) => family !== "Others");

test("categorizeModelFamily keeps featured families and buckets the rest as Others", () => {
  assert.ok(FEATURED_FAMILIES.length > 0, "expected at least one featured family");
  for (const family of FEATURED_FAMILIES) {
    assert.equal(categorizeModelFamily(family), family);
  }
  assert.equal(categorizeModelFamily("mock-family"), "Others");
  assert.equal(categorizeModelFamily("NotAFamily"), "Others");
  assert.equal(categorizeModelFamily(undefined), "Others");
});

test("MODEL_FAMILY_SORT_ORDER lists each family once with Others last", () => {
  assert.equal(MODEL_FAMILY_SORT_ORDER.at(-1), "Others");
  assert.equal(MODEL_FAMILY_SORT_ORDER.filter((family) => family === "Others").length, 1);
  assert.equal(new Set(MODEL_FAMILY_SORT_ORDER).size, MODEL_FAMILY_SORT_ORDER.length);
});

test("MODEL_FAMILY_NAV_ITEMS mirrors the sort order", () => {
  const names = MODEL_FAMILY_NAV_ITEMS.map((item) => item.name);
  assert.deepEqual(names, [...MODEL_FAMILY_SORT_ORDER]);
  for (const item of MODEL_FAMILY_NAV_ITEMS) {
    assert.equal(item.anchorId, getModelFamilyAnchorId(item.name));
    assert.ok(item.anchorId.endsWith("-models"));
  }
});
