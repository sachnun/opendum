import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildCanonicalIndex,
  canonicalBare,
  canonicalModelId,
  normalizeCanonicalKey,
  resolveCanonical,
  resolveCanonicalFrom,
  type CanonicalSources,
} from "#models/model/canonical.ts";

function sources(): CanonicalSources {
  return {
    models: {
      "anthropic/claude-opus-4-5": { name: "Claude Opus 4.5", family: "claude-opus" },
      "anthropic/claude-opus-4-5-20251101": { name: "Claude Opus 4.5 (dated)" },
      "deepseek/deepseek-v4.1-flash": { name: "DeepSeek V4.1 Flash" },
      "nvidia/nemotron-3-ultra-550b-a55b": { name: "Nemotron 3 Ultra" },
      "zhipuai/glm-5.3-flash": { name: "GLM-5.3 Flash" },
      "alibaba/qwen3.8-max": { name: "Qwen3.8 Max" },
      "minimax/MiniMax-M3": { name: "MiniMax M3" },
    },
    providers: {
      deepseek: {
        models: {
          "deepseek-v4-flash": { canonical_model_id: "deepseek/deepseek-v4.1-flash" },
          "deepseek-flash": { canonical_model_id: "deepseek/deepseek-v4.1-flash" },
        },
      },
      kilo: {
        models: {
          "z-ai/glm-5.3-flash": { canonical_model_id: "zhipuai/glm-5.3-flash" },
          "nvidia/nemotron-3-ultra-550b-a55b:free": {
            canonical_model_id: "nvidia/nemotron-3-ultra-550b-a55b",
          },
        },
      },
      minimax: {
        models: {
          "MiniMax-M3": { canonical_model_id: "minimax/MiniMax-M3" },
        },
      },
    },
    openrouter: {
      data: [{ id: "deepseek/deepseek-v4-flash", canonical_slug: "deepseek/deepseek-v4.1-flash" }],
    },
  };
}

test("normalizeCanonicalKey folds spelling and drops variant suffixes", () => {
  assert.equal(normalizeCanonicalKey("anthropic/claude-opus-4.5"), "anthropic/claude-opus-4-5");
  assert.equal(normalizeCanonicalKey("nvidia/Nemotron_3"), "nvidia/nemotron-3");
  assert.equal(normalizeCanonicalKey("poolside/laguna-s-2.1:free"), "poolside/laguna-s-2-1");
  assert.equal(normalizeCanonicalKey("  vendor/model  "), "vendor/model");
  assert.equal(normalizeCanonicalKey(null), "");
});

test("canonicalBare keeps the model segment only", () => {
  assert.equal(canonicalBare("anthropic/claude-opus-4-5"), "claude-opus-4-5");
  assert.equal(canonicalBare("mimo-v2.5"), "mimo-v2.5");
});

test("buildCanonicalIndex prefers the shorter id on normalization collisions", () => {
  const index = buildCanonicalIndex(sources());
  const model = index.models.get("claude-opus-4-5");
  assert.equal(model?.bare, "claude-opus-4-5");
  assert.equal(model?.lab, "anthropic");
});

test("resolveCanonical matches an exact canonical id at tier exact", () => {
  const index = buildCanonicalIndex(sources());
  const hit = resolveCanonical("anthropic/claude-opus-4-5", index);
  assert.equal(hit?.id, "claude-opus-4-5");
  assert.equal(hit?.lab, "anthropic");
  assert.equal(hit?.tier, "exact");
  assert.equal(hit?.score, 1);
});

test("resolveCanonical folds dots onto the dash canonical id", () => {
  const index = buildCanonicalIndex(sources());
  assert.equal(canonicalModelId("zhipuai/glm-5.3-flash", index), "glm-5.3-flash");
  assert.equal(canonicalModelId("MiniMax-M3", index), "MiniMax-M3");
});

test("resolveCanonical follows a provider offering link at tier linked", () => {
  const index = buildCanonicalIndex(sources());
  const hit = resolveCanonical("deepseek-v4-flash", index, { provider: "deepseek" });
  assert.equal(hit?.id, "deepseek-v4.1-flash");
  assert.equal(hit?.tier, "linked");
});

test("resolveCanonical follows provider-scoped links only for that provider", () => {
  const index = buildCanonicalIndex(sources());
  assert.equal(canonicalModelId("z-ai/glm-5.3-flash", index, { provider: "kilo_code" }), "glm-5.3-flash");
  assert.equal(
    canonicalModelId("nvidia/nemotron-3-ultra-550b-a55b:free", index, { provider: "kilo_code" }),
    "nemotron-3-ultra-550b-a55b",
  );
});

test("resolveCanonical reads OpenRouter canonical_slug links", () => {
  const index = buildCanonicalIndex(sources());
  const hit = resolveCanonical("deepseek/deepseek-v4-flash", index, { provider: "openrouter" });
  assert.equal(hit?.id, "deepseek-v4.1-flash");
  assert.equal(hit?.tier, "linked");
});

test("resolveCanonical prefers exact over a conflicting provider link", () => {
  const index = buildCanonicalIndex(sources());
  const hit = resolveCanonical("deepseek/deepseek-v4.1-flash", index, { provider: "deepseek" });
  assert.equal(hit?.tier, "exact");
  assert.equal(hit?.id, "deepseek-v4.1-flash");
});

test("resolveCanonical resolves a size-stripped probe via unique fuzzy match", () => {
  const index = buildCanonicalIndex(sources());
  const hit = resolveCanonical("nemotron-3-ultra", index);
  assert.equal(hit?.tier, "fuzzy");
  assert.equal(hit?.id, "nemotron-3-ultra-550b-a55b");
});

test("resolveCanonicalFrom ignores an exact alias when core probes resolve later", () => {
  const index = buildCanonicalIndex({
    models: {
      "meta/llama-3.1-8b-instruct": { name: "Llama 3.1 8B" },
      "meta/llama-3.1-70b-instruct": { name: "Llama 3.1 70B" },
    },
  });
  const hit = resolveCanonicalFrom(["llama-3.1", "meta/llama-3.1-8b-instruct"], index, {
    fallbackProbes: ["llama-3.1-70b-instruct", "llama-3.1-8b-instruct"],
  });
  assert.equal(hit?.id, "llama-3.1-8b-instruct");
});

test("resolveCanonicalFrom falls back to aliases when core probes find nothing", () => {
  const index = buildCanonicalIndex({
    models: { "meta/llama-3.1-70b-instruct": { name: "Llama 3.1 70B" } },
  });
  const hit = resolveCanonicalFrom(["llama-3.1", "unserved-name"], index, {
    fallbackProbes: ["llama-3.1-70b-instruct"],
  });
  assert.equal(hit?.id, "llama-3.1-70b-instruct");
});

test("resolveCanonical fails closed when a fuzzy probe is ambiguous", () => {
  const index = buildCanonicalIndex({
    models: {
      "google/gemma-4-31b-it": { name: "Gemma 4 31B" },
      "google/gemma-4-12b-it": { name: "Gemma 4 12B" },
    },
  });
  assert.equal(resolveCanonical("gemma-4", index), null);
  assert.equal(canonicalModelId("gemma-4-31b", index), "gemma-4-31b-it");
});

test("resolveCanonical rejects a fuzzy match that changes the family prefix", () => {
  const index = buildCanonicalIndex(sources());
  assert.equal(resolveCanonical("ox", index), null);
  assert.equal(resolveCanonical("ling-2.6-flash", index), null);
});

test("resolveCanonicalFrom tries every probe per tier before falling back", () => {
  const index = buildCanonicalIndex(sources());
  const hit = resolveCanonicalFrom(["totally-unrelated", "deepseek-v4-flash"], index, { provider: "deepseek" });
  assert.equal(hit?.id, "deepseek-v4.1-flash");
  assert.equal(hit?.tier, "linked");
});

test("resolveCanonicalFrom prefers an exact probe over a linked one", () => {
  const index = buildCanonicalIndex(sources());
  const hit = resolveCanonicalFrom(["deepseek-v4-flash", "MiniMax-M3"], index, { provider: "deepseek" });
  assert.equal(hit?.id, "MiniMax-M3");
  assert.equal(hit?.tier, "exact");
});

test("resolveCanonicalFrom returns null when every probe misses", () => {
  const index = buildCanonicalIndex(sources());
  assert.equal(resolveCanonicalFrom(["nope", ""], index), null);
});

test("resolveCanonical returns null for unrelated or empty probes", () => {
  const index = buildCanonicalIndex(sources());
  assert.equal(resolveCanonical("totally-unrelated-model", index), null);
  assert.equal(resolveCanonical("", index), null);
  assert.equal(resolveCanonical(null, index), null);
  assert.equal(resolveCanonical(undefined, index), null);
});

test("resolveCanonical rejects cross-version fuzzy matches", () => {
  const index = buildCanonicalIndex(sources());
  assert.equal(resolveCanonical("glm-4.6-flash", index), null);
});
test("buildCanonicalIndex tolerates empty and malformed sources", () => {
  const index = buildCanonicalIndex({});
  assert.equal(index.models.size, 0);
  assert.equal(index.offerings.size, 0);
  assert.equal(resolveCanonical("anything", index), null);

  const malformed = buildCanonicalIndex({
    models: { "lab/model": null, "": {} },
    providers: { lab: { models: { x: {} } } },
    openrouter: { data: [{ id: "" }] },
  });
  assert.equal(malformed.models.size, 1);
  assert.equal(malformed.offerings.size, 0);
});
