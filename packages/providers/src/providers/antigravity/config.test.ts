import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  RETIRED_MODEL_PATTERN,
  anySlice,
  defaultAny,
  inferEnumType,
  mapSlice,
  normalizeSchemaType,
  randomHyphenId,
  randomUuid,
  sanitizedToolName,
} from "#providers/providers/antigravity/config.ts";

describe("antigravity config helpers", () => {
  it("defaultAny keeps defined values", () => {
    assert.equal(defaultAny(undefined, "x"), "x");
    assert.equal(defaultAny(null, "x"), "x");
    assert.equal(defaultAny(0, "x"), 0);
  });

  it("slices arrays and object arrays", () => {
    assert.deepEqual(anySlice([1, 2]), [1, 2]);
    assert.deepEqual(anySlice("x"), []);
    assert.deepEqual(mapSlice([{ a: 1 }, null, 1, [], { b: 2 }]), [{ a: 1 }, { b: 2 }]);
  });

  it("generates uuids and hyphen ids", () => {
    assert.match(randomUuid(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.match(randomHyphenId("req"), /^req-[0-9a-f-]{36}$/);
  });

  it("normalizes schema types", () => {
    assert.equal(normalizeSchemaType("string"), "string");
    assert.equal(normalizeSchemaType(["null", "integer"]), "integer");
    assert.equal(normalizeSchemaType(["null"]), "null");
    assert.equal(normalizeSchemaType([]), "");
    assert.equal(normalizeSchemaType(undefined), "");
  });

  it("sanitizes tool names", () => {
    assert.equal(sanitizedToolName("1abc"), "t_1abc");
    assert.equal(sanitizedToolName("abc"), "abc");
    assert.equal(sanitizedToolName(""), "");
  });

  it("infers enum types", () => {
    assert.equal(inferEnumType(["a"]), "string");
    assert.equal(inferEnumType([true]), "boolean");
    assert.equal(inferEnumType([1]), "integer");
    assert.equal(inferEnumType([1.5]), "number");
    assert.equal(inferEnumType([]), "string");
  });

  it("matches retired model messages", () => {
    assert.equal(RETIRED_MODEL_PATTERN.test("gpt-x is no longer available. Please switch to gemini"), true);
  });
});
