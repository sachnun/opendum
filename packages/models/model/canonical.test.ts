import { expect, test } from "bun:test";

import {
  canonicalIndex,
  canonicalBare,
  canonicalId,
  canonicalKey,
  resolveCanonical,
  resolveFrom,
  type CanonicalSources,
} from "./canonical.ts";

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

test("canonicalKey folds spelling and drops variant suffixes", () => {
  expect(canonicalKey("anthropic/claude-opus-4.5")).toBe("anthropic/claude-opus-4-5");
  expect(canonicalKey("nvidia/Nemotron_3")).toBe("nvidia/nemotron-3");
  expect(canonicalKey("poolside/laguna-s-2.1:free")).toBe("poolside/laguna-s-2-1");
  expect(canonicalKey("  vendor/model  ")).toBe("vendor/model");
  expect(canonicalKey(null)).toBe("");
});

test("canonicalBare keeps the model segment only", () => {
  expect(canonicalBare("anthropic/claude-opus-4-5")).toBe("claude-opus-4-5");
  expect(canonicalBare("mimo-v2.5")).toBe("mimo-v2.5");
});

test("canonicalIndex prefers the shorter id on normalization collisions", () => {
  const index = canonicalIndex(sources());
  const model = index.models.get("claude-opus-4-5");
  expect(model?.bare).toBe("claude-opus-4-5");
  expect(model?.lab).toBe("anthropic");
});

test("resolveCanonical matches an exact canonical id at tier exact", () => {
  const index = canonicalIndex(sources());
  const hit = resolveCanonical("anthropic/claude-opus-4-5", index);
  expect(hit?.id).toBe("claude-opus-4-5");
  expect(hit?.lab).toBe("anthropic");
  expect(hit?.tier).toBe("exact");
  expect(hit?.score).toBe(1);
});

test("resolveCanonical folds dots onto the dash canonical id", () => {
  const index = canonicalIndex(sources());
  expect(canonicalId("zhipuai/glm-5.3-flash", index)).toBe("glm-5.3-flash");
  expect(canonicalId("MiniMax-M3", index)).toBe("MiniMax-M3");
});

test("resolveCanonical follows a provider offering link at tier linked", () => {
  const index = canonicalIndex(sources());
  const hit = resolveCanonical("deepseek-v4-flash", index, { provider: "deepseek" });
  expect(hit?.id).toBe("deepseek-v4.1-flash");
  expect(hit?.tier).toBe("linked");
});

test("resolveCanonical follows provider-scoped links only for that provider", () => {
  const index = canonicalIndex(sources());
  expect(canonicalId("z-ai/glm-5.3-flash", index, { provider: "kilo_code" })).toBe("glm-5.3-flash");
  expect(canonicalId("nvidia/nemotron-3-ultra-550b-a55b:free", index, { provider: "kilo_code" })).toBe("nemotron-3-ultra-550b-a55b");
});

test("resolveCanonical reads OpenRouter canonical_slug links", () => {
  const index = canonicalIndex(sources());
  const hit = resolveCanonical("deepseek/deepseek-v4-flash", index, { provider: "openrouter" });
  expect(hit?.id).toBe("deepseek-v4.1-flash");
  expect(hit?.tier).toBe("linked");
});

test("resolveCanonical prefers exact over a conflicting provider link", () => {
  const index = canonicalIndex(sources());
  const hit = resolveCanonical("deepseek/deepseek-v4.1-flash", index, { provider: "deepseek" });
  expect(hit?.tier).toBe("exact");
  expect(hit?.id).toBe("deepseek-v4.1-flash");
});

test("resolveCanonical resolves a size-stripped probe via unique fuzzy match", () => {
  const index = canonicalIndex(sources());
  const hit = resolveCanonical("nemotron-3-ultra", index);
  expect(hit?.tier).toBe("fuzzy");
  expect(hit?.id).toBe("nemotron-3-ultra-550b-a55b");
});

test("resolveFrom ignores an exact alias when core probes resolve later", () => {
  const index = canonicalIndex({
    models: {
      "meta/llama-3.1-8b-instruct": { name: "Llama 3.1 8B" },
      "meta/llama-3.1-70b-instruct": { name: "Llama 3.1 70B" },
    },
  });
  const hit = resolveFrom(["llama-3.1", "meta/llama-3.1-8b-instruct"], index, {
    fallbackProbes: ["llama-3.1-70b-instruct", "llama-3.1-8b-instruct"],
  });
  expect(hit?.id).toBe("llama-3.1-8b-instruct");
});

test("resolveFrom falls back to aliases when core probes find nothing", () => {
  const index = canonicalIndex({
    models: { "meta/llama-3.1-70b-instruct": { name: "Llama 3.1 70B" } },
  });
  const hit = resolveFrom(["llama-3.1", "unserved-name"], index, {
    fallbackProbes: ["llama-3.1-70b-instruct"],
  });
  expect(hit?.id).toBe("llama-3.1-70b-instruct");
});

test("resolveCanonical fails closed when a fuzzy probe is ambiguous", () => {
  const index = canonicalIndex({
    models: {
      "google/gemma-4-31b-it": { name: "Gemma 4 31B" },
      "google/gemma-4-12b-it": { name: "Gemma 4 12B" },
    },
  });
  expect(resolveCanonical("gemma-4", index)).toBe(null);
  expect(canonicalId("gemma-4-31b", index)).toBe("gemma-4-31b-it");
});

test("resolveCanonical rejects a fuzzy match that changes the family prefix", () => {
  const index = canonicalIndex(sources());
  expect(resolveCanonical("ox", index)).toBe(null);
  expect(resolveCanonical("ling-2.6-flash", index)).toBe(null);
});

test("resolveFrom tries every probe per tier before falling back", () => {
  const index = canonicalIndex(sources());
  const hit = resolveFrom(["totally-unrelated", "deepseek-v4-flash"], index, { provider: "deepseek" });
  expect(hit?.id).toBe("deepseek-v4.1-flash");
  expect(hit?.tier).toBe("linked");
});

test("resolveFrom prefers an exact probe over a linked one", () => {
  const index = canonicalIndex(sources());
  const hit = resolveFrom(["deepseek-v4-flash", "MiniMax-M3"], index, { provider: "deepseek" });
  expect(hit?.id).toBe("MiniMax-M3");
  expect(hit?.tier).toBe("exact");
});

test("resolveFrom returns null when every probe misses", () => {
  const index = canonicalIndex(sources());
  expect(resolveFrom(["nope", ""], index)).toBe(null);
});

test("resolveCanonical returns null for unrelated or empty probes", () => {
  const index = canonicalIndex(sources());
  expect(resolveCanonical("totally-unrelated-model", index)).toBe(null);
  expect(resolveCanonical("", index)).toBe(null);
  expect(resolveCanonical(null, index)).toBe(null);
  expect(resolveCanonical(undefined, index)).toBe(null);
});

test("resolveCanonical rejects cross-version fuzzy matches", () => {
  const index = canonicalIndex(sources());
  expect(resolveCanonical("glm-4.6-flash", index)).toBe(null);
});
test("canonicalIndex tolerates empty and malformed sources", () => {
  const index = canonicalIndex({});
  expect(index.models.size).toBe(0);
  expect(index.offerings.size).toBe(0);
  expect(resolveCanonical("anything", index)).toBe(null);

  const malformed = canonicalIndex({
    models: { "lab/model": null, "": {} },
    providers: { lab: { models: { x: {} } } },
    openrouter: { data: [{ id: "" }] },
  });
  expect(malformed.models.size).toBe(1);
  expect(malformed.offerings.size).toBe(0);
});
