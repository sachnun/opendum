import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { AnthropicStreamTracker } from "../src/core/streaming/anthropic-stream.ts";

type Json = Record<string, unknown>;

function tracker(keepThinkingOpen = false): { tracker: AnthropicStreamTracker; events: Array<{ event: string; data: Json }> } {
  const events: Array<{ event: string; data: Json }> = [];
  const instance = new AnthropicStreamTracker((event, data) => events.push({ event, data }), "m", keepThinkingOpen);
  return { tracker: instance, events };
}

function feed(target: AnthropicStreamTracker, payload: Json): void {
  target.process(`data: ${JSON.stringify(payload)}\n\n`);
}

function names(events: Array<{ event: string }>): string[] {
  return events.map((entry) => entry.event);
}

describe("AnthropicStreamTracker text and thinking", () => {
  it("streams text deltas", () => {
    const { tracker: t, events } = tracker();
    feed(t, { choices: [{ delta: { content: "hi" } }] });
    assert.deepEqual(names(events), ["content_block_start", "content_block_delta"]);
    assert.deepEqual(events[1]!.data.delta, { type: "text_delta", text: "hi" });
    t.finish();
    assert.equal(events.at(-1)!.data.type, "message_stop");
  });

  it("streams thinking deltas when not kept open", () => {
    const { tracker: t, events } = tracker(false);
    feed(t, { choices: [{ delta: { reasoning_content: "why" } }] });
    assert.equal(events[0]!.data.content_block instanceof Object, true);
    assert.deepEqual(events[1]!.data.delta, { type: "thinking_delta", thinking: "why" });
  });

  it("reopens thinking blocks after text", () => {
    const { tracker: t, events } = tracker(true);
    feed(t, { choices: [{ delta: { reasoning_content: "a" } }] });
    feed(t, { choices: [{ delta: { content: "x" } }] });
    feed(t, { choices: [{ delta: { content: "y" } }] });
    feed(t, { choices: [{ delta: { reasoning_content: "b" } }] });
    t.finish();
    const thinkingDeltas = events.filter((entry) => (entry.data.delta as Json | undefined)?.type === "thinking_delta");
    assert.equal(thinkingDeltas.length >= 2, true);
  });

  it("buffers text while keeping thinking open", () => {
    const { tracker: t, events } = tracker(true);
    feed(t, { choices: [{ delta: { reasoning_content: "why" } }] });
    feed(t, { choices: [{ delta: { content: "first" } }] });
    feed(t, { choices: [{ delta: { content: "second" } }] });
    t.finish();
    const textEvents = events.filter((entry) => entry.data.type === "content_block_delta");
    assert.equal(textEvents.some((entry) => (entry.data.delta as Json).type === "text_delta"), true);
  });

  it("finishes while a thinking block is still open", () => {
    const { tracker: t, events } = tracker(true);
    feed(t, { choices: [{ delta: { reasoning_content: "why" } }] });
    t.finish();
    assert.equal(events.at(-1)!.data.type, "message_stop");
  });

  it("starts a tool block while keeping a thinking block open", () => {
    const { tracker: t, events } = tracker(true);
    feed(t, { choices: [{ delta: { reasoning_content: "why" } }] });
    feed(t, { choices: [{ delta: { tool_calls: [{ index: 0, id: "t1", function: { name: "f", arguments: "{}" } }] } }] });
    const starts = events.filter((entry) => entry.data.type === "content_block_start");
    assert.equal(starts.some((entry) => (entry.data.content_block as Json).type === "tool_use"), true);
    t.finish();
    assert.equal(events.at(-1)!.data.type, "message_stop");
  });
});

describe("AnthropicStreamTracker tools", () => {
  it("streams tool calls with ids and arguments", () => {
    const { tracker: t, events } = tracker();
    feed(t, { choices: [{ delta: { tool_calls: [{ index: 0, id: "t1", function: { name: "f", arguments: '{"a":' } }] } }] });
    feed(t, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] } }] });
    const starts = events.filter((entry) => entry.data.type === "content_block_start");
    assert.equal(starts.length, 1);
    assert.deepEqual(starts[0]!.data.content_block, { type: "tool_use", id: "t1", name: "f", input: {} });
    const deltas = events.filter((entry) => entry.data.type === "content_block_delta");
    assert.equal(deltas.length, 2);
    t.finish();
    assert.equal(events.some((entry) => entry.data.type === "content_block_stop"), true);
  });

  it("generates ids and reuses blocks by index", () => {
    const { tracker: t, events } = tracker();
    feed(t, { choices: [{ delta: { tool_calls: [{ index: 3, function: { name: "f" } }] } }] });
    feed(t, { choices: [{ delta: { tool_calls: [{ index: 3, function: { arguments: "{}" } }] } }] });
    const starts = events.filter((entry) => entry.data.type === "content_block_start");
    assert.equal(starts.length, 1);
    assert.match(String((starts[0]!.data.content_block as Json).id), /^toolu_/);
  });
});

describe("AnthropicStreamTracker finish", () => {
  it("maps finish reasons and usage", () => {
    const { tracker: t, events } = tracker();
    feed(t, { choices: [{ delta: { content: "hi" }, finish_reason: "length" }] });
    feed(t, { usage: { prompt_tokens: 5, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 1, cache_write_tokens: 2 } } });
    t.finish();
    const delta = events.find((entry) => entry.data.type === "message_delta")!;
    assert.equal((delta.data.delta as Json).stop_reason, "max_tokens");
    assert.equal((delta.data.usage as Json).input_tokens, 5);
    assert.equal((delta.data.usage as Json).cache_read_input_tokens, 1);
    assert.equal((delta.data.usage as Json).cache_creation_input_tokens, 2);
  });

  it("maps tool finish reasons", () => {
    const { tracker: t, events } = tracker();
    feed(t, { choices: [{ delta: { tool_calls: [{ index: 0, id: "t1", function: { name: "f" } }] }, finish_reason: "tool_calls" }] });
    t.finish();
    const delta = events.find((entry) => entry.data.type === "message_delta")!;
    assert.equal((delta.data.delta as Json).stop_reason, "tool_use");
  });

  it("flushes incomplete events on finish", () => {
    const { tracker: t, events } = tracker();
    t.process('data: {"choices":[{"delta":{"content":"hi"}}]}');
    t.finish();
    assert.equal(events.some((entry) => (entry.data.delta as Json | undefined)?.text === "hi" || entry.data.type === "content_block_delta"), true);
  });

  it("ignores invalid events", () => {
    const write = vi.fn();
    const instance = new AnthropicStreamTracker(write, "m", false);
    instance.process("data: not json\n\n");
    instance.process("data: {}\n\n");
    instance.finish();
    assert.equal(write.mock.calls.some((call) => call[0] === "message_stop"), true);
  });
});
