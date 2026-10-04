import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Registry, suggestionScoreFor } from "./runtime.ts";

const dataDir = fileURLToPath(new URL("../data", import.meta.url));
const registry = Registry.load(dataDir);

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

describe("access rules and case folding", () => {
  it("trims and folds model ids case-insensitively", () => {
    const sample = registry.allModels()[0];
    assert.ok(sample, "expected at least one model");
    assert.equal(registry.resolveAlias(sample), sample);
    assert.equal(registry.resolveAlias(`  ${sample}  `), sample);
    assert.equal(registry.resolveAlias(sample.toUpperCase()), sample);
    assert.equal(registry.resolveAlias(sample), registry.resolveAlias(sample.toUpperCase()));
  });
});
