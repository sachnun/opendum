import { expect, test } from "bun:test";

import {
  NAV_ITEMS,
  SORT_ORDER,
  categorize,
  anchorId,
} from "./ranking.ts";

const FEATURED_FAMILIES = SORT_ORDER.filter((family) => family !== "Others");

test("categorize keeps featured families and buckets the rest as Others", () => {
  expect(FEATURED_FAMILIES.length > 0, "expected at least one featured family").toBeTruthy();
  for (const family of FEATURED_FAMILIES) {
    expect(categorize(family)).toBe(family);
  }
  expect(categorize("mock-family")).toBe("Others");
  expect(categorize("NotAFamily")).toBe("Others");
  expect(categorize(undefined)).toBe("Others");
});

test("SORT_ORDER lists each family once with Others last", () => {
  expect(SORT_ORDER.at(-1)).toBe("Others");
  expect(SORT_ORDER.filter((family) => family === "Others").length).toBe(1);
  expect(new Set(SORT_ORDER).size).toBe(SORT_ORDER.length);
});

test("NAV_ITEMS mirrors the sort order", () => {
  const names = NAV_ITEMS.map((item) => item.name);
  expect(names).toEqual([...SORT_ORDER]);
  for (const item of NAV_ITEMS) {
    expect(item.anchorId).toBe(anchorId(item.name));
    expect(item.anchorId.endsWith("-models")).toBeTruthy();
  }
});
