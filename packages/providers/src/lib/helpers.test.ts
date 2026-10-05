import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  boolFromAny,
  cloneAnyMap,
  contentToText,
  defaultEmpty,
  defaultStringValue,
  extractInstructions,
  filterKeys,
  isTruthful,
  jsonResponse,
  normalizeToolChoice,
  numberFromAny,
  parseSseDataLines,
  randomId,
  sseResponse,
  stringSlice,
  stringValue,
  uniqueStrings,
} from "#providers/lib/helpers.ts";

describe("primitive coercion", () => {
  it("stringValue and defaults", () => {
    assert.equal(stringValue("x"), "x");
    assert.equal(stringValue(3), "");
    assert.equal(defaultStringValue("", "fallback"), "fallback");
    assert.equal(defaultStringValue("v", "fallback"), "v");
    assert.equal(defaultEmpty("", "fallback"), "fallback");
    assert.equal(defaultEmpty("v", "fallback"), "v");
  });

  it("numberFromAny truncates valid numbers", () => {
    assert.equal(numberFromAny(3.9), 3);
    assert.equal(numberFromAny("4.7"), 4);
    assert.equal(numberFromAny("  "), 0);
    assert.equal(numberFromAny("abc"), 0);
    assert.equal(numberFromAny(Number.NaN), 0);
  });

  it("boolean helpers", () => {
    assert.equal(boolFromAny(true), true);
    assert.equal(boolFromAny("true"), false);
    assert.equal(isTruthful(true), true);
    assert.equal(isTruthful(1), false);
  });
});

describe("collection helpers", () => {
  it("cloneAnyMap deep-clones plain objects only", () => {
    const nested = { a: { b: 1 } };
    const list = [1, 2];
    const cloned = cloneAnyMap({ nested, list });
    assert.deepEqual(cloned.nested, { a: { b: 1 } });
    assert.notEqual(cloned.nested, nested);
    assert.equal(cloned.list, list);
  });

  it("uniqueStrings drops empty and duplicate values", () => {
    assert.deepEqual(uniqueStrings(["a", "", "a", "b"]), ["a", "b"]);
  });

  it("stringSlice keeps non-empty strings", () => {
    assert.deepEqual(stringSlice(["a", 1, "b"]), ["a", "b"]);
    assert.deepEqual(stringSlice("nope"), []);
  });

  it("filterKeys keeps supported non-null entries", () => {
    assert.deepEqual(filterKeys({ a: 1, b: null, c: undefined, d: 2 }, new Set(["a", "b", "c"])), { a: 1 });
  });
});

describe("contentToText", () => {
  it("reads strings and objects", () => {
    assert.equal(contentToText("hi"), "hi");
    assert.equal(contentToText({ text: "hi" }), "hi");
    assert.equal(contentToText({ input_text: "in" }), "in");
    assert.equal(contentToText({ content: "nested" }), "nested");
    assert.equal(contentToText(42), "");
  });

  it("joins array parts and tool results", () => {
    assert.equal(contentToText([{ text: "a" }, { output_text: "b" }, { type: "tool_result", content: "c" }]), "abc");
  });
});

describe("normalizeToolChoice", () => {
  it("flattens function choices", () => {
    assert.deepEqual(normalizeToolChoice({ type: "function", function: { name: "f" } }), { type: "function", name: "f" });
    assert.deepEqual(normalizeToolChoice({ type: "function", name: "f" }), { type: "function", name: "f" });
  });

  it("passes through unsupported choices", () => {
    assert.deepEqual(normalizeToolChoice({ type: "function" }), { type: "function" });
    assert.equal(normalizeToolChoice("auto"), "auto");
    assert.deepEqual(normalizeToolChoice({ type: "auto" }), { type: "auto" });
  });
});

describe("response factories", () => {
  it("builds json responses", async () => {
    const resp = jsonResponse(201, { ok: true });
    assert.equal(resp.status, 201);
    assert.equal(resp.headers.get("content-type"), "application/json");
    assert.deepEqual(await resp.json(), { ok: true });
  });

  it("builds sse responses", () => {
    const resp = sseResponse(new ReadableStream());
    assert.equal(resp.status, 200);
    assert.equal(resp.headers.get("content-type"), "text/event-stream");
  });
});

describe("extractInstructions", () => {
  it("joins system and developer prompts", () => {
    const text = extractInstructions([
      { role: "system", content: "one" },
      { role: "developer", content: "two" },
      { role: "user", content: "ignore" },
    ]);
    assert.equal(text, "one\n\ntwo");
  });
});

describe("parseSseDataLines", () => {
  it("parses valid data lines", () => {
    const events = parseSseDataLines('data: {"a":1}\n\ndata: [DONE]\n\nnot-data\n\ndata: bad\n');
    assert.deepEqual(events, [{ a: 1 }]);
  });
});

describe("randomId", () => {
  it("prefixes random hex", () => {
    assert.match(randomId("call"), /^call_[0-9a-f]{32}$/);
  });
});
