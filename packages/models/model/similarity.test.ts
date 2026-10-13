import { expect, test } from "bun:test";

import {
  buildIndex,
  isCompatible,
  normalizeKey,
  normalizeName,
  resolveCandidates,
  similarityScore,
  stripDateSuffix,
} from "./similarity.ts";

test("normalizeName strips provider prefix, suffixes and separators", () => {
  expect(normalizeName("vendor/Mock-Model:free")).toBe("mock-model");
  expect(normalizeName("vendor/mock_model.4")).toBe("mock-model-4");
  expect(normalizeName("  vendor/mock--variant  ")).toBe("mock-variant");
  expect(normalizeName(null)).toBe("");
  expect(normalizeName(undefined)).toBe("");
});

test("normalizeName strips batch and thinking suffixes", () => {
  expect(normalizeName("vendor/mock-model:batch")).toBe("mock-model");
  expect(normalizeName("vendor/mock-model:thinking")).toBe("mock-model");
});

test("stripDateSuffix only removes 4-8 digit trailing tokens", () => {
  expect(stripDateSuffix("mock-model-20250514")).toBe("mock-model");
  expect(stripDateSuffix("mock-model-0813")).toBe("mock-model");
  expect(stripDateSuffix("mock-model-4")).toBe("mock-model-4");
  expect(stripDateSuffix("20250514")).toBe("20250514");
});

test("normalizeKey combines normalization and date stripping", () => {
  expect(normalizeKey("vendor/mock-model-20240101")).toBe("mock-model");
});

test("similarityScore is exact for equal and high for containment", () => {
  expect(similarityScore("mock-model-a", "mock-model-a")).toBe(1);
  expect(similarityScore("mock-model-a", "mock-model-a-mini")).toBe(0.95);
  expect(similarityScore("mock-model-sonet-x", "mock-model-sonnet-x") > 0.9).toBeTruthy();
  expect(similarityScore("totally-unrelated", "mock-model-sonnet-x") < 0.5).toBeTruthy();
});

test("similarityScore tolerates reordered tokens", () => {
  expect(similarityScore("claude-haiku-4-5", "claude-4-5-haiku") >= 0.9).toBeTruthy();
  expect(similarityScore("gemma-4-e2b", "gemma-4-e2b-it") >= 0.9).toBeTruthy();
});

test("similarityScore stays below the default threshold for unrelated ids", () => {
  const threshold = 0.72;
  expect(similarityScore("ox", "voxtral-mini-3b-2507") < threshold).toBeTruthy();
  expect(similarityScore("atria-dawn", "lyria-3-pro-preview") < threshold).toBeTruthy();
});

test("resolveCandidates requires a shared family below the strong-score bar", () => {
  const index = buildIndex<number>([{ id: "vendor/mimo-2.6-flash", entry: 1 }], "test");
  expect(resolveCandidates(["ling-2.6-flash"], index).match).toBe(null);
  expect(resolveCandidates(["ling-2.6-flash"], index, { threshold: 0.1 }).match).toBe(null);
});

test("similarityScore only rewards token-aligned containment", () => {
  expect(similarityScore("mock-model-a", "mock-model-a-mini")).toBe(0.95);
  expect(similarityScore("ox", "voxtral-mini") < 0.72).toBeTruthy();
  expect(similarityScore("qwen3", "qwen3-next")).toBe(0.95);
});

test("isCompatible rejects differing version numbers", () => {
  expect(isCompatible("mock-model-4-31b", "mock-model-3-12b")).toBe(false);
  expect(isCompatible("mock-model-4-31b", "mock-model-4-31b-thinking")).toBe(true);
});

test("isCompatible treats one-sided variant tokens as compatible", () => {
  expect(isCompatible("mock-model-opus-4-6-thinking", "mock-model-opus-4-6")).toBe(true);
  expect(isCompatible("mock-model-a-mini", "mock-model-a-large")).toBe(false);
});

test("buildIndex deduplicates by normalized key keeping the first entry", () => {
  const index = buildIndex<number>(
    [
      { id: "vendor/mock-model", entry: 1 },
      { id: "mock-model", entry: 2 },
      { id: "mock-model-20240101", entry: 3 },
    ],
    "test",
  );
  expect(index.size).toBe(1);
  expect(index.get("mock-model")?.entry).toBe(1);
  expect(index.get("mock-model")?.source).toBe("test");
});

test("resolveCandidates returns exact matches first", () => {
  const index = buildIndex<number>([{ id: "vendor/mock-model", entry: 7 }], "test");
  const result = resolveCandidates(["Mock-Model"], index);
  expect(result.exact?.matched).toBe("Mock-Model");
  expect(result.exact?.entry).toBe(7);
  expect(result.match).toBe(null);
});

test("resolveCandidates fuzzy matches compatible typos", () => {
  const index = buildIndex<number>([{ id: "vendor/mock-model-sonnet-x", entry: 1 }], "test");
  const result = resolveCandidates(["mock-model-sonet-x"], index);
  expect(result.exact).toBe(null);
  expect(result.match?.entry).toBe(1);
  expect((result.match?.score ?? 0) >= 0.72).toBeTruthy();
});

test("resolveCandidates respects threshold and compatibility", () => {
  const index = buildIndex<number>([{ id: "vendor/mock-model-sonnet-x", entry: 1 }], "test");
  expect(resolveCandidates(["mock-model-sonnet-y"], index, { threshold: 1 }).match).toBe(null);
  const versioned = buildIndex<number>([{ id: "vendor/mock-model-sonnet-4", entry: 1 }], "test");
  expect(resolveCandidates(["mock-model-sonnet-3"], versioned, { threshold: 0.1 }).match).toBe(null);
});

test("resolveCandidates ignores empty candidate keys", () => {
  const index = buildIndex<number>([{ id: "mock-model", entry: 1 }], "test");
  const result = resolveCandidates(["", "///"], index);
  expect(result.exact).toBe(null);
  expect(result.match).toBe(null);
});
