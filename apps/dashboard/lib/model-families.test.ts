import { test } from "node:test";
import assert from "node:assert/strict";

import { MODEL_FAMILY_NAV_ITEMS, MODEL_FAMILY_SORT_ORDER, categorizeModelFamily } from "./model-families";

test("categorizeModelFamily keeps featured families and buckets the rest as Others", () => {
  assert.equal(categorizeModelFamily("Anthropic"), "Anthropic");
  assert.equal(categorizeModelFamily("OpenAI"), "OpenAI");
  assert.equal(categorizeModelFamily("Z.AI"), "Z.AI");
  assert.equal(categorizeModelFamily("NotAFamily"), "Others");
  assert.equal(categorizeModelFamily(undefined), "Others");
});

test("MODEL_FAMILY_SORT_ORDER is benchmark ordered with Others last", () => {
  assert.equal(MODEL_FAMILY_SORT_ORDER[0], "Anthropic");
  assert.equal(MODEL_FAMILY_SORT_ORDER.at(-1), "Others");
  assert.ok(MODEL_FAMILY_SORT_ORDER.indexOf("OpenAI") < MODEL_FAMILY_SORT_ORDER.indexOf("Mistral"));
});

test("MODEL_FAMILY_NAV_ITEMS mirrors the sort order", () => {
  const names = MODEL_FAMILY_NAV_ITEMS.map((item) => item.name);
  assert.deepEqual(names, [...MODEL_FAMILY_SORT_ORDER]);
  for (const item of MODEL_FAMILY_NAV_ITEMS) {
    assert.ok(item.anchorId.endsWith("-models"));
  }
});
