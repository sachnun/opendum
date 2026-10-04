import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("provider config merge", () => {
  it("keeps provider flags outside the known fields", () => {
    const root = mkdtempSync(join(tmpdir(), "opendum-models-"));
    const authoredDir = join(root, "data");
    const generatedDir = join(root, "generated");
    mkdirSync(authoredDir, { recursive: true });
    mkdirSync(generatedDir, { recursive: true });
    writeFileSync(
      join(authoredDir, "muse-spark-1.3.json"),
      JSON.stringify({ providerConfig: { opencode: { responses_api: true } } })
    );
    writeFileSync(
      join(generatedDir, "muse-spark-1.3.json"),
      JSON.stringify({
        providers: ["opencode"],
        providerConfig: {
          opencode: { upstream: "muse-spark-1.3-free", contextWindow: 1000, maxOutputTokens: 100 },
        },
      })
    );

    const merged = Registry.load(authoredDir);
    const cfg = merged.providerModelConfig("muse-spark-1.3", "opencode");
    assert.equal(cfg?.upstream, "muse-spark-1.3-free");
    assert.equal(cfg?.contextWindow, 1000);
    assert.equal(cfg?.maxOutputTokens, 100);
    const custom = cfg?.custom as Record<string, unknown> | undefined;
    assert.equal(custom?.responses_api, true);
    assert.notEqual(cfg?.responses_api, false);
  });
});
