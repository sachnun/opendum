import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { convertKiroEventsToCompletion } from "#providers/providers/kiro/transform.ts";

type Json = Record<string, unknown>;

function firstChoice(completion: Json): Json {
  return (completion.choices as Json[])[0]!;
}

function messageOf(completion: Json): Json {
  return firstChoice(completion).message as Json;
}

describe("convertKiroEventsToCompletion", () => {
  it("collects text content", () => {
    const completion = convertKiroEventsToCompletion([{ content: "hello" }, { content: " world" }], "claude", true);
    assert.equal(messageOf(completion).content, "hello world");
    assert.equal(firstChoice(completion).finish_reason, "stop");
  });

  it("extracts thinking tags into reasoning", () => {
    const completion = convertKiroEventsToCompletion([{ content: "a <thinking>pondering</thinking> b" }], "claude", true);
    assert.equal(messageOf(completion).content, "a  b");
    assert.equal(messageOf(completion).reasoning_content, "pondering");
  });

  it("captures native reasoning events", () => {
    const completion = convertKiroEventsToCompletion(
      [{ reasoningContentEvent: { text: "because" } }, { content: "answer" }],
      "claude",
      true
    );
    assert.equal(messageOf(completion).content, "answer");
    assert.equal(messageOf(completion).reasoning_content, "because");
  });

  it("builds tool calls from events and accumulates partial input", () => {
    const completion = convertKiroEventsToCompletion(
      [{ name: "lookup", toolUseId: "t1", input: '{"q":' }, { input: '"x"}' }],
      "claude",
      true
    );
    assert.deepEqual(messageOf(completion).tool_calls, [
      { id: "t1", type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } },
    ]);
    assert.equal(firstChoice(completion).finish_reason, "tool_calls");
  });

  it("parses bracketed tool calls embedded in content", () => {
    const completion = convertKiroEventsToCompletion([{ content: 'done [Called f with args: {"a":1}]' }], "claude", true);
    assert.equal(messageOf(completion).content, "done");
    const calls = messageOf(completion).tool_calls as Json[];
    assert.equal((calls[0]!.function as Json).name, "f");
    assert.equal((calls[0]!.function as Json).arguments, '{"a":1}');
    assert.equal(firstChoice(completion).finish_reason, "tool_calls");
  });

  it("prefers explicit usage and falls back to context usage", () => {
    const explicit = convertKiroEventsToCompletion([{ content: "hi" }, { usage: { inputTokens: 5, outputTokens: 2 } }], "claude", true);
    assert.equal((explicit.usage as Json).total_tokens, 7);

    const fallback = convertKiroEventsToCompletion([{ content: "hello", contextUsagePercentage: 50 }], "claude", true);
    assert.equal((fallback.usage as Json).total_tokens, 100000);
  });

  it("ignores error events", () => {
    const completion = convertKiroEventsToCompletion([{ message: "boom", error: "x" }], "claude", true);
    assert.equal(messageOf(completion).content, null);
  });
});
