import { describe, expect, test } from "bun:test";
import { normalizeIds, sameList } from "~/lib/access-draft";

describe("access draft", () => {
  test("compares lists element-wise", () => {
    expect(sameList(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameList(["a", "b"], ["b", "a"])).toBe(false);
    expect(sameList([], [])).toBe(true);
    expect(sameList(["a"], [])).toBe(false);
  });

  test("normalizes ids by deduplicating and sorting", () => {
    expect(normalizeIds(["b", "a", "b"])).toEqual(["a", "b"]);
    expect(normalizeIds(["b", "a"], (left, right) => (left < right ? -1 : left > right ? 1 : 0))).toEqual(["a", "b"]);
  });
});
