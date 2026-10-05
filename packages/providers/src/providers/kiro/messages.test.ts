import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  convertKiroTools,
  mergeAdjacentKiroMessages,
  mergeKiroContent,
  normalizeKiroToolMessages,
  splitKiroSystemMessages,
} from "#providers/providers/kiro/messages.ts";

type Json = Record<string, unknown>;

describe("convertKiroTools", () => {
  it("returns an empty list for non-arrays", () => {
    assert.deepEqual(convertKiroTools("nope"), []);
    assert.deepEqual(convertKiroTools(null), []);
  });

  it("converts function-style tools", () => {
    const tools = convertKiroTools([
      { function: { name: "lookup", description: "d", parameters: { type: "object", properties: { q: {} } } } },
    ]);
    assert.deepEqual(tools, [
      {
        toolSpecification: {
          name: "lookup",
          description: "d",
          inputSchema: { json: { type: "object", properties: { q: {} } } },
        },
      },
    ]);
  });

  it("converts directly-shaped tools using input_schema", () => {
    const tools = convertKiroTools([{ name: "direct", input_schema: { type: "object" } }]);
    assert.deepEqual(tools, [
      { toolSpecification: { name: "direct", description: "", inputSchema: { json: { type: "object" } } } },
    ]);
  });

  it("skips tools without a name and defaults invalid parameters", () => {
    assert.deepEqual(convertKiroTools([{ function: {} }]), []);
    const tools = convertKiroTools([{ function: { name: "h", parameters: [1, 2] } }]);
    assert.deepEqual((tools[0] as Json).toolSpecification, {
      name: "h",
      description: "",
      inputSchema: { json: { type: "object", properties: {} } },
    });
  });
});

describe("splitKiroSystemMessages", () => {
  it("collects system and developer prompts and keeps the rest", () => {
    const result = splitKiroSystemMessages([
      { role: "system", content: "a" },
      { role: "developer", content: { text: "b" } },
      { role: "user", content: "c" },
    ]);
    assert.equal(result.systemPrompt, "a\n\nb");
    assert.deepEqual(result.messages, [{ role: "user", content: "c" }]);
  });
});

describe("mergeKiroContent", () => {
  it("concatenates two arrays", () => {
    assert.deepEqual(mergeKiroContent(["a"], ["b"]), ["a", "b"]);
  });

  it("appends or prepends text parts", () => {
    assert.deepEqual(mergeKiroContent(["a"], "b"), ["a", { type: "text", text: "b" }]);
    assert.deepEqual(mergeKiroContent("a", ["b"]), [{ type: "text", text: "a" }, "b"]);
  });

  it("leaves an array untouched for non-string scalars", () => {
    assert.deepEqual(mergeKiroContent(["a"], 5), ["a"]);
    assert.deepEqual(mergeKiroContent(5, ["b"]), ["b"]);
  });

  it("joins plain text", () => {
    assert.equal(mergeKiroContent("a", "b"), "a\nb");
    assert.equal(mergeKiroContent("a", ""), "a");
    assert.equal(mergeKiroContent("", ""), "");
  });
});

describe("normalizeKiroToolMessages", () => {
  it("groups tool results into a following user message", () => {
    const normalized = normalizeKiroToolMessages([
      { role: "assistant", content: "x" },
      { role: "tool", tool_call_id: "t1", content: "r1" },
      { role: "tool", content: "r2" },
      { role: "user", content: "hi" },
    ]);
    assert.equal(normalized.length, 2);
    const user = normalized[1] as Json;
    assert.equal(user.role, "user");
    const content = user.content as Json[];
    assert.equal(content.length, 3);
    assert.equal(content[0]!.tool_call_id, "t1");
    assert.match(String(content[1]!.tool_call_id), /^toolu_/);
    assert.deepEqual(content[2], { type: "text", text: "hi" });
  });

  it("flushes trailing tool results as a user message", () => {
    const normalized = normalizeKiroToolMessages([{ role: "tool", tool_call_id: "t1", content: "r" }]);
    assert.equal(normalized.length, 1);
    assert.equal((normalized[0] as Json).role, "user");
  });

  it("passes through unrelated roles", () => {
    const source = [{ role: "system", content: "s" }];
    assert.deepEqual(normalizeKiroToolMessages(source), source);
  });
});

describe("mergeAdjacentKiroMessages", () => {
  it("merges adjacent same-role messages", () => {
    assert.deepEqual(mergeAdjacentKiroMessages([{ role: "user", content: "a" }, { role: "user", content: "b" }]), [
      { role: "user", content: "a\nb" },
    ]);
  });

  it("does not merge across tool messages", () => {
    assert.equal(
      mergeAdjacentKiroMessages([
        { role: "user", content: "a" },
        { role: "tool", content: "t" },
        { role: "user", content: "b" },
      ]).length,
      3
    );
  });

  it("combines content and tool calls for adjacent assistants", () => {
    const merged = mergeAdjacentKiroMessages([
      { role: "assistant", content: "a", tool_calls: [{ id: 1 }] },
      { role: "assistant", content: "b", tool_calls: [{ id: 2 }] },
    ]);
    assert.equal(merged.length, 1);
    const first = merged[0] as Json;
    assert.equal(first.content, "a\nb");
    assert.deepEqual(first.tool_calls, [{ id: 1 }, { id: 2 }]);
  });
});
