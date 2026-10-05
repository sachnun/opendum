import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isKiroResponseEvent,
  keepKiroParserTail,
  KiroParserState,
  nextKiroJsonStart,
  normalizeKiroResponseEvents,
  parseKiroJsonEvents,
} from "#providers/providers/kiro/parse.ts";

describe("nextKiroJsonStart", () => {
  it("finds the earliest known event marker", () => {
    assert.equal(nextKiroJsonStart('xx{"content":"a"}', 0), 2);
    assert.equal(nextKiroJsonStart('{"message":"x"} {"content":"a"}', 0), 0);
  });

  it("respects the offset and returns -1 when absent", () => {
    assert.equal(nextKiroJsonStart('{"content":"a"}', 3), -1);
    assert.equal(nextKiroJsonStart("plain text", 0), -1);
  });
});

describe("keepKiroParserTail", () => {
  it("keeps short buffers intact and truncates long ones", () => {
    assert.equal(keepKiroParserTail("short"), "short");
    const long = "x".repeat(100);
    assert.equal(keepKiroParserTail(long), long.slice(-64));
  });
});

describe("normalizeKiroResponseEvents", () => {
  it("hoists known nested event keys and tags their type", () => {
    const events = normalizeKiroResponseEvents({ assistantResponseEvent: { content: "hi" }, tokenUsage: { total: 3 } });
    assert.deepEqual(events, [
      { content: "hi", type: "assistantResponseEvent" },
      { total: 3, type: "tokenUsage" },
    ]);
  });

  it("duplicates the nested payload for reasoning events", () => {
    const events = normalizeKiroResponseEvents({ reasoningContentEvent: { reasoningContent: { text: "why" } } });
    assert.deepEqual(events, [
      {
        reasoningContent: { text: "why" },
        type: "reasoningContentEvent",
        reasoningContentEvent: { reasoningContent: { text: "why" } },
      },
    ]);
  });

  it("passes through an event without known nested keys", () => {
    const event = { content: "hello" };
    assert.deepEqual(normalizeKiroResponseEvents(event), [event]);
  });
});

describe("isKiroResponseEvent", () => {
  it("accepts content without a followup prompt", () => {
    assert.equal(isKiroResponseEvent({ content: "hi" }), true);
    assert.equal(isKiroResponseEvent({ content: "hi", followupPrompt: "" }), false);
  });

  it("accepts tool, input, stop, usage and error shapes", () => {
    assert.equal(isKiroResponseEvent({ name: "tool", toolUseId: "t1" }), true);
    assert.equal(isKiroResponseEvent({ input: "{}" }), true);
    assert.equal(isKiroResponseEvent({ stop: true }), true);
    assert.equal(isKiroResponseEvent({ contextUsagePercentage: 12 }), true);
    assert.equal(isKiroResponseEvent({ error: "boom" }), true);
    assert.equal(isKiroResponseEvent({ Error: "boom" }), true);
    assert.equal(isKiroResponseEvent({ message: "boom" }), true);
  });

  it("rejects unrelated shapes", () => {
    assert.equal(isKiroResponseEvent({}), false);
    assert.equal(isKiroResponseEvent({ other: 1 }), false);
  });
});

describe("parseKiroJsonEvents", () => {
  it("parses a complete event embedded in noise", () => {
    const state = new KiroParserState();
    assert.deepEqual(parseKiroJsonEvents('junk{"content":"hello"}tail', state), [{ content: "hello" }]);
  });

  it("parses multiple events", () => {
    const state = new KiroParserState();
    const events = parseKiroJsonEvents('{"content":"a"}{"input":"{}"}', state);
    assert.deepEqual(events, [{ content: "a" }, { input: "{}" }]);
  });

  it("handles nested braces and braces inside strings", () => {
    const state = new KiroParserState();
    const events = parseKiroJsonEvents('{"content":"} {","meta":{"a":{"b":1}}}', state);
    assert.deepEqual(events, [{ content: "} {", meta: { a: { b: 1 } } }]);
  });

  it("retains an incomplete event across chunks", () => {
    const state = new KiroParserState();
    assert.deepEqual(parseKiroJsonEvents('{"content":"hel', state), []);
    assert.deepEqual(parseKiroJsonEvents('lo"}', state), [{ content: "hello" }]);
  });

  it("parses an event followed by trailing whitespace", () => {
    const state = new KiroParserState();
    assert.deepEqual(parseKiroJsonEvents('{"content":"a"} ', state), [{ content: "a" }]);
    assert.equal(state.buffer, " ");
  });

  it("skips malformed json", () => {
    const state = new KiroParserState();
    assert.deepEqual(parseKiroJsonEvents('{"content":}', state), []);
  });
});
