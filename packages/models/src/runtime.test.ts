import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { suggestionScoreFor } from "./runtime.ts";

describe("model suggestion score", () => {
  it("matches an identical value", () => {
    assert.equal(suggestionScoreFor("gpt-4o", "gpt-4o"), 1);
  });

  it("matches a compacted typo above the threshold", () => {
    assert.ok(suggestionScoreFor("gpt4o", "gpt-4o") >= 0.7);
  });

  it("matches a substring strongly", () => {
    const score = suggestionScoreFor("claude", "claude-sonnet-4-6");
    assert.ok(score >= 0.7);
    assert.ok(score < 1);
  });

  it("rejects an unrelated candidate", () => {
    assert.ok(suggestionScoreFor("claude-sonnet-4-6", "gpt-4o") < 0.7);
  });

  it("handles empty input", () => {
    assert.equal(suggestionScoreFor("", "gpt-4o"), 0);
    assert.equal(suggestionScoreFor("gpt-4o", ""), 0);
  });
});
