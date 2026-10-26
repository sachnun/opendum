import { describe, expect, it } from "bun:test";

import { normalizeIds, sameList } from "~~/lib/access-draft";

describe("access draft helpers", () => {
  it("dedupes and sorts identifiers", () => {
    expect(normalizeIds(["b", "a", "b"])).toEqual(["a", "b"]);
  });

  it("compares ordered identifier lists", () => {
    expect(sameList(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameList(["a", "b"], ["b", "a"])).toBe(false);
    expect(sameList(["a"], ["a", "b"])).toBe(false);
  });
});
