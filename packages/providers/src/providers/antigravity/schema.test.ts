import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bestSchemaUnionOption,
  buildToolSchemaMap,
  cloneSchemaWithoutUnions,
  enumFromSchemaUnion,
  filteredSchemaRequired,
  flattenAntigravityClaudeUnion,
  geminiTools,
  inferAntigravityClaudeSchemaType,
  sanitizeAntigravityClaudeToolSchema,
  sanitizeGoogleFunctionSchema,
  sanitizeToolSchemaKeys,
  schemaTypeAllowsNull,
  schemaUnionOptionScore,
} from "#providers/providers/antigravity/schema.ts";

type Json = Record<string, unknown>;

describe("geminiTools", () => {
  it("converts function declarations", () => {
    const tools = geminiTools([
      { function: { name: "f", description: "d", parameters: { type: "object", properties: { a: { type: "string" } } } } },
    ]);
    assert.deepEqual(tools, [
      { name: "f", description: "d", parameters: { type: "object", properties: { a: { type: "string" } } } },
    ]);
  });

  it("skips nameless tools and defaults parameters", () => {
    assert.deepEqual(geminiTools([{ function: { name: "" } }]), []);
    assert.deepEqual(geminiTools([{ function: { name: "f" } }]), [{ name: "f", description: "", parameters: { type: "object" } }]);
    assert.deepEqual(geminiTools("nope"), []);
  });
});

describe("sanitizeGoogleFunctionSchema", () => {
  it("handles invalid input", () => {
    assert.deepEqual(sanitizeGoogleFunctionSchema(null), {});
    assert.deepEqual(sanitizeGoogleFunctionSchema("nope" as unknown as Json), {});
  });

  it("keeps supported keys and drops unknown ones", () => {
    assert.deepEqual(sanitizeGoogleFunctionSchema({ type: "string", description: "d", format: "f", title: "t", unknown: 1 }), {
      type: "string",
      description: "d",
      format: "f",
      title: "t",
    });
  });

  it("handles nullable unions and const enums", () => {
    assert.deepEqual(sanitizeGoogleFunctionSchema({ type: ["string", "null"] }), { type: "string", nullable: true });
    assert.deepEqual(sanitizeGoogleFunctionSchema({ const: "x" }), { enum: ["x"] });
  });

  it("infers object and array types", () => {
    assert.deepEqual(sanitizeGoogleFunctionSchema({ properties: { a: { type: "string" } } }), {
      properties: { a: { type: "string" } },
      type: "object",
    });
    assert.deepEqual(sanitizeGoogleFunctionSchema({ type: "array", items: { type: "number" } }), {
      type: "array",
      items: { type: "number" },
    });
    assert.deepEqual(sanitizeGoogleFunctionSchema({ items: { type: "number" } }), {
      items: { type: "number" },
      type: "array",
    });
  });

  it("sanitizes nested properties, anyOf and empty properties", () => {
    assert.deepEqual(sanitizeGoogleFunctionSchema({ type: "object", properties: {} }), { type: "object" });
    assert.deepEqual(sanitizeGoogleFunctionSchema({ anyOf: [{ type: "string" }, { type: "number" }] }), {
      anyOf: [{ type: "string" }, { type: "number" }],
    });
  });
});

describe("schemaTypeAllowsNull", () => {
  it("detects null members", () => {
    assert.equal(schemaTypeAllowsNull(["string", "null"]), true);
    assert.equal(schemaTypeAllowsNull("null"), false);
    assert.equal(schemaTypeAllowsNull("string"), false);
  });
});

describe("sanitizeAntigravityClaudeToolSchema", () => {
  it("defaults invalid schemas", () => {
    assert.deepEqual(sanitizeAntigravityClaudeToolSchema(null), { type: "object", properties: {}, required: [] });
  });

  it("filters required entries to known properties", () => {
    const result = sanitizeAntigravityClaudeToolSchema({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "number" } },
      required: ["a", "b", "c"],
    });
    assert.deepEqual(result, {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "number" } },
      required: ["a", "b"],
    });
  });

  it("keeps enums and infers types", () => {
    assert.deepEqual(sanitizeAntigravityClaudeToolSchema({ type: "string", enum: ["a", "b"] }), { type: "string", enum: ["a", "b"] });
    assert.deepEqual(sanitizeAntigravityClaudeToolSchema({ const: "x" }), { enum: ["x"], type: "string" });
    assert.deepEqual(sanitizeAntigravityClaudeToolSchema({ type: "array" }), { type: "array", items: {} });
  });

  it("flattens unions", () => {
    assert.deepEqual(
      sanitizeAntigravityClaudeToolSchema({ anyOf: [{ type: "string", enum: ["a"] }, { type: "string", enum: ["b"] }] }),
      { enum: ["a", "b"], type: "string" }
    );
  });
});

describe("union helpers", () => {
  it("extracts enums from unions", () => {
    assert.deepEqual(enumFromSchemaUnion([{ const: "a" }, { enum: ["b", "c"] }, { type: "null" }]), [["a", "b", "c"], true]);
    assert.deepEqual(enumFromSchemaUnion([{ type: "integer" }]), [[], false]);
  });

  it("scores union options", () => {
    assert.equal(schemaUnionOptionScore({ type: "object", properties: { a: {} } }), 60);
    assert.equal(schemaUnionOptionScore({ type: "object" }), 50);
    assert.equal(schemaUnionOptionScore({ type: "array", items: {} }), 45);
    assert.equal(schemaUnionOptionScore({ type: "array" }), 40);
    assert.equal(schemaUnionOptionScore({ type: "string", enum: ["a"] }), 35);
    assert.equal(schemaUnionOptionScore({ type: "string" }), 30);
    assert.equal(schemaUnionOptionScore({ type: "number" }), 20);
    assert.equal(schemaUnionOptionScore({ type: "boolean" }), 10);
    assert.equal(schemaUnionOptionScore({ properties: {} }), 55);
    assert.equal(schemaUnionOptionScore({ items: {} }), 42);
    assert.equal(schemaUnionOptionScore({ const: "x" }), 32);
    assert.equal(schemaUnionOptionScore({}), 1);
  });

  it("picks the best option and handles null-only unions", () => {
    assert.deepEqual(bestSchemaUnionOption([{ type: "string" }, { type: "object", properties: { a: {} } }]), {
      type: "object",
      properties: { a: {} },
    });
    assert.deepEqual(bestSchemaUnionOption([{ type: "null" }]), { type: "null" });
  });

  it("flattens unions and strips union keys", () => {
    const merged = flattenAntigravityClaudeUnion({ anyOf: [{ type: "string", enum: ["a"] }, { type: "string", enum: ["b"] }] });
    assert.deepEqual(merged, { enum: ["a", "b"], type: "string" });

    const object = flattenAntigravityClaudeUnion({ oneOf: [{ type: "null" }, { type: "object", properties: { x: { type: "string" } } }] });
    assert.deepEqual(object, { type: "object", properties: { x: { type: "string" } } });

    const plain = { type: "string" };
    assert.equal(flattenAntigravityClaudeUnion(plain), plain);
    assert.deepEqual(cloneSchemaWithoutUnions({ anyOf: [], oneOf: [], allOf: [], a: 1 }), { a: 1 });
  });

  it("filters required names", () => {
    assert.deepEqual(filteredSchemaRequired(["a", "b", "a", "", 1], { a: {}, b: {} }), ["a", "b"]);
  });

  it("infers claude schema types", () => {
    assert.equal(inferAntigravityClaudeSchemaType({ properties: {} }), "object");
    assert.equal(inferAntigravityClaudeSchemaType({ items: {} }), "array");
    assert.equal(inferAntigravityClaudeSchemaType({ enum: [true] }), "boolean");
    assert.equal(inferAntigravityClaudeSchemaType({ enum: [] }), "object");
  });
});

describe("buildToolSchemaMap", () => {
  it("maps sanitized and original tool names", () => {
    const map = buildToolSchemaMap([
      {
        functionDeclarations: [
          { name: "1bad", parametersJsonSchema: { type: "object", properties: { x: { type: "number" }, y: {} } } },
          { name: "good", parameters: { type: "object", properties: { z: { type: "string" } } } },
          { name: "", parameters: { type: "object", properties: { z: {} } } },
          { name: "empty", parameters: { type: "object", properties: {} } },
        ],
      },
    ]);
    assert.deepEqual(map["t_1bad"], { x: { typ: "number" }, y: { typ: "unknown" } });
    assert.deepEqual(map["1bad"], { x: { typ: "number" }, y: { typ: "unknown" } });
    assert.deepEqual(map.good, { z: { typ: "string" } });
    assert.equal("empty" in map, false);
    assert.deepEqual(buildToolSchemaMap("nope"), {});
  });

  it("adds sanitized keys for existing maps", () => {
    const schemas: Record<string, Record<string, { typ: string }>> = { "1bad": { x: { typ: "number" } } };
    sanitizeToolSchemaKeys(schemas);
    assert.deepEqual(schemas["t_1bad"], { x: { typ: "number" } });
  });
});
