import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  OpenAIStreamUsageTracker,
  emptyUsage,
  usageCacheCounts,
  usageFromJson,
  usageObject,
} from "../src/core/metering/usage.ts";

describe("usageObject", () => {
  it("reads direct and nested usage", () => {
    assert.deepEqual(usageObject({ usage: { prompt_tokens: 1 } }), { prompt_tokens: 1 });
    assert.deepEqual(usageObject({ response: { usage: { input_tokens: 2 } } }), { input_tokens: 2 });
    assert.equal(usageObject({ response: { usage: "nope" } }), null);
    assert.equal(usageObject({}), null);
  });
});

describe("usageCacheCounts", () => {
  it("prefers prompt details then input details", () => {
    assert.deepEqual(usageCacheCounts({ prompt_tokens_details: { cached_tokens: 1, cache_write_tokens: 2 } }), { cached: 1, write: 2 });
    assert.deepEqual(usageCacheCounts({ input_tokens_details: { cached_tokens: 3, cache_write_tokens: 4 } }), { cached: 3, write: 4 });
    assert.deepEqual(usageCacheCounts({ cache_read_input_tokens: 5, cache_creation_input_tokens: 6 }), { cached: 5, write: 6 });
    assert.deepEqual(usageCacheCounts({}), { cached: 0, write: 0 });
  });
});

describe("usageFromJson", () => {
  it("maps chat and responses usage", () => {
    assert.deepEqual(usageFromJson({ usage: { prompt_tokens: 5, completion_tokens: 3 } }), {
      inputTokens: 5,
      outputTokens: 3,
      cachedTokens: 0,
      cacheWriteTokens: 0,
    });
    assert.deepEqual(usageFromJson({ usage: { input_tokens: 7, output_tokens: 2 } }), {
      inputTokens: 7,
      outputTokens: 2,
      cachedTokens: 0,
      cacheWriteTokens: 0,
    });
    assert.deepEqual(usageFromJson({}), emptyUsage());
  });
});

describe("OpenAIStreamUsageTracker", () => {
  it("collects usage, cache counts and hypercredits", () => {
    const tracker = new OpenAIStreamUsageTracker();
    tracker.process(
      'data: {"usage":{"prompt_tokens":5,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":1,"cache_write_tokens":2},"remaining":{"hypercredits":10},"cost":{"hypercredits":4}}}\n\n'
    );
    assert.equal(tracker.inputTokens, 5);
    assert.equal(tracker.outputTokens, 3);
    assert.equal(tracker.cachedTokens, 1);
    assert.equal(tracker.cacheWriteTokens, 2);
    assert.equal(tracker.hypercreditsRemaining, 10);
    assert.equal(tracker.hypercreditsCost, 4);
  });

  it("flushes buffered events", () => {
    const tracker = new OpenAIStreamUsageTracker();
    tracker.process('data: {"usage":{"input_tokens":9}}');
    assert.equal(tracker.inputTokens, 0);
    tracker.flush();
    assert.equal(tracker.inputTokens, 9);
  });

  it("ignores malformed events", () => {
    const tracker = new OpenAIStreamUsageTracker();
    tracker.process("data: not json\n\n");
    tracker.process("data: {}\n\n");
    assert.equal(tracker.inputTokens, 0);
  });
});
