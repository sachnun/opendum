import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { Registry, suggestionScoreFor } from "./runtime.ts";

const dataDir = fileURLToPath(new URL("./data", import.meta.url));
const registry = Registry.load(dataDir);

describe("model suggestion score", () => {
  it("matches an identical value", () => {
    expect(suggestionScoreFor("gpt-4o", "gpt-4o")).toBe(1);
  });

  it("matches a compacted typo above the threshold", () => {
    expect(suggestionScoreFor("gpt4o", "gpt-4o") >= 0.7).toBeTruthy();
  });

  it("matches a substring strongly", () => {
    const score = suggestionScoreFor("claude", "claude-sonnet-4-6");
    expect(score >= 0.7).toBeTruthy();
    expect(score < 1).toBeTruthy();
  });

  it("rejects an unrelated candidate", () => {
    expect(suggestionScoreFor("claude-sonnet-4-6", "gpt-4o") < 0.7).toBeTruthy();
  });

  it("handles empty input", () => {
    expect(suggestionScoreFor("", "gpt-4o")).toBe(0);
    expect(suggestionScoreFor("gpt-4o", "")).toBe(0);
  });
});

describe("access rules and case folding", () => {
  it("trims and folds model ids case-insensitively", () => {
    const sample = registry.allModels()[0];
    expect(sample).toBeTruthy();
    expect(registry.resolveAlias(sample)).toBe(sample);
    expect(registry.resolveAlias(`  ${sample}  `)).toBe(sample);
    expect(registry.resolveAlias(sample.toUpperCase())).toBe(sample);
    expect(registry.resolveAlias(sample)).toBe(registry.resolveAlias(sample.toUpperCase()));
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
    expect(cfg?.upstream).toBe("muse-spark-1.3-free");
    expect(cfg?.contextWindow).toBe(1000);
    expect(cfg?.maxOutputTokens).toBe(100);
    const custom = cfg?.custom as Record<string, unknown> | undefined;
    expect(custom?.responses_api).toBe(true);
    expect(cfg?.responses_api).not.toBe(false);
  });
});
