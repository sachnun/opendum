import { describe, expect, test } from "bun:test";

import {
  arrayAt,
  asArray,
  asBoolean,
  asNumber,
  asRecord,
  asString,
  trimmed,
  booleanAt,
  idsOf,
  numberAt,
  recordAt,
  sortedUnique,
  stringAt,
  uniqueStrings,
} from "@opendum/models/json";

describe("json accessors", () => {
  test("narrow records and reject arrays, null, and primitives", () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    expect(asRecord([])).toBe(null);
    expect(asRecord(null)).toBe(null);
    expect(asRecord("x")).toBe(null);
  });

  test("narrow primitives", () => {
    expect(asString("x")).toBe("x");
    expect(asString(1)).toBeUndefined();
    expect(trimmed("  x  ")).toBe("x");
    expect(trimmed("   ")).toBeUndefined();
    expect(asNumber(1.5)).toBe(1.5);
    expect(asNumber(Number.NaN)).toBeUndefined();
    expect(asNumber("1")).toBeUndefined();
    expect(asBoolean(true)).toBe(true);
    expect(asBoolean("true")).toBeUndefined();
    expect(asArray([1])).toEqual([1]);
    expect(asArray("x")).toEqual([]);
  });

  test("navigate nested payloads without throwing", () => {
    const payload = { data: [{ id: "a", meta: { count: 2, live: true } }], version: "1" };
    expect(arrayAt(payload, "data").length).toBe(1);
    expect(arrayAt(payload, "missing")).toEqual([]);
    expect(recordAt(payload, "data")).toBe(null);
    expect(stringAt(payload, "version")).toBe("1");
    expect(numberAt(recordAt(arrayAt(payload, "data")[0], "meta"), "count")).toBe(2);
    expect(booleanAt(recordAt(arrayAt(payload, "data")[0], "meta"), "live")).toBe(true);
    expect(stringAt(payload, "data")).toBeUndefined();
  });

  test("collect unique ids and strings deterministically", () => {
    expect(idsOf([{ id: " b " }, { id: "a" }, { id: "a" }, {}, null, { id: 5 }])).toEqual(["a", "b"]);
    expect(uniqueStrings(["b", "a", "b", "  ", undefined])).toEqual(["b", "a"]);
    expect(sortedUnique(["b", "a", "b"])).toEqual(["a", "b"]);
  });
});
