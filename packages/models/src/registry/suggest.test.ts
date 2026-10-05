import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeCandidate, suggestionScore, suggestionScoreFor } from "#models/registry/suggest.ts";

describe("makeCandidate", () => {
  it("lowercases and splits on separators", () => {
    const candidate = makeCandidate("  GPT-4o.Mini_v2  ");
    assert.equal(candidate.value, "  GPT-4o.Mini_v2  ");
    assert.equal(candidate.normalized, "gpt 4o mini v2");
    assert.deepEqual(candidate.tokens, ["gpt", "4o", "mini", "v2"]);
  });

  it("keeps unicode letters and numbers", () => {
    const candidate = makeCandidate("München-Über");
    assert.equal(candidate.normalized, "münchen über");
  });

  it("collapses runs of separators", () => {
    assert.equal(makeCandidate("a---b").normalized, "a b");
    assert.deepEqual(makeCandidate("a---b").tokens, ["a", "b"]);
  });
});

describe("suggestionScore", () => {
  it("scores identical values 1", () => {
    assert.equal(suggestionScore(makeCandidate("claude"), makeCandidate("claude")), 1);
  });

  it("is case and separator insensitive", () => {
    assert.equal(suggestionScoreFor("Claude Sonnet", "claude-sonnet"), 1);
  });

  it("scores a prefix between 0.8 and 1", () => {
    const score = suggestionScoreFor("claude", "claude-sonnet");
    assert.ok(score >= 0.8 && score < 1, `unexpected score ${score}`);
  });

  it("returns 0 for empty input", () => {
    assert.equal(suggestionScore(makeCandidate(""), makeCandidate("x")), 0);
    assert.equal(suggestionScore(makeCandidate("x"), makeCandidate("")), 0);
  });

  it("prefers token overlap when present", () => {
    const tokenMatch = suggestionScoreFor("sonnet 4", "claude sonnet 4");
    const noise = suggestionScoreFor("sonnet 4", "zzzzzz");
    assert.ok(tokenMatch > noise, `${tokenMatch} should beat ${noise}`);
  });

  it("penalizes unrelated long strings", () => {
    assert.ok(suggestionScoreFor("alpha-beta", "gamma-delta-zeta") < 0.5);
  });
});
