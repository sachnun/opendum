import { expect, test } from "bun:test";

import {
  MODEL_FAMILY_NAV_ITEMS,
  MODEL_FAMILY_SORT_ORDER,
  categorizeModelFamily,
  getModelFamilyAnchorId,
} from "./ranking.ts";

const FEATURED_FAMILIES = MODEL_FAMILY_SORT_ORDER.filter((family) => family !== "Others");

test("categorizeModelFamily keeps featured families and buckets the rest as Others", () => {
  expect(FEATURED_FAMILIES.length > 0, "expected at least one featured family").toBeTruthy();
  for (const family of FEATURED_FAMILIES) {
    expect(categorizeModelFamily(family)).toBe(family);
  }
  expect(categorizeModelFamily("mock-family")).toBe("Others");
  expect(categorizeModelFamily("NotAFamily")).toBe("Others");
  expect(categorizeModelFamily(undefined)).toBe("Others");
});

test("MODEL_FAMILY_SORT_ORDER lists each family once with Others last", () => {
  expect(MODEL_FAMILY_SORT_ORDER.at(-1)).toBe("Others");
  expect(MODEL_FAMILY_SORT_ORDER.filter((family) => family === "Others").length).toBe(1);
  expect(new Set(MODEL_FAMILY_SORT_ORDER).size).toBe(MODEL_FAMILY_SORT_ORDER.length);
});

test("MODEL_FAMILY_NAV_ITEMS mirrors the sort order", () => {
  const names = MODEL_FAMILY_NAV_ITEMS.map((item) => item.name);
  expect(names).toEqual([...MODEL_FAMILY_SORT_ORDER]);
  for (const item of MODEL_FAMILY_NAV_ITEMS) {
    expect(item.anchorId).toBe(getModelFamilyAnchorId(item.name));
    expect(item.anchorId.endsWith("-models")).toBeTruthy();
  }
});
