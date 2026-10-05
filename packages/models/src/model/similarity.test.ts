import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildIndex,
  isCompatible,
  normalizeKey,
  normalizeName,
  resolveCandidates,
  similarityScore,
  stripDateSuffix,
} from "#models/model/similarity.ts";

test("normalizeName strips provider prefix, suffixes and separators", () => {
  assert.equal(normalizeName("vendor/Mock-Model:free"), "mock-model");
  assert.equal(normalizeName("vendor/mock_model.4"), "mock-model-4");
  assert.equal(normalizeName("  vendor/mock--variant  "), "mock-variant");
  assert.equal(normalizeName(null), "");
  assert.equal(normalizeName(undefined), "");
});

test("normalizeName strips batch and thinking suffixes", () => {
  assert.equal(normalizeName("vendor/mock-model:batch"), "mock-model");
  assert.equal(normalizeName("vendor/mock-model:thinking"), "mock-model");
});

test("stripDateSuffix only removes 4-8 digit trailing tokens", () => {
  assert.equal(stripDateSuffix("mock-model-20250514"), "mock-model");
  assert.equal(stripDateSuffix("mock-model-0813"), "mock-model");
  assert.equal(stripDateSuffix("mock-model-4"), "mock-model-4");
  assert.equal(stripDateSuffix("20250514"), "20250514");
});

test("normalizeKey combines normalization and date stripping", () => {
  assert.equal(normalizeKey("vendor/mock-model-20240101"), "mock-model");
});

test("similarityScore is exact for equal and high for containment", () => {
  assert.equal(similarityScore("mock-model-a", "mock-model-a"), 1);
  assert.equal(similarityScore("mock-model-a", "mock-model-a-mini"), 0.95);
  assert.ok(similarityScore("mock-model-sonet-x", "mock-model-sonnet-x") > 0.9);
  assert.ok(similarityScore("totally-unrelated", "mock-model-sonnet-x") < 0.5);
});

test("similarityScore tolerates reordered tokens", () => {
  assert.ok(similarityScore("claude-haiku-4-5", "claude-4-5-haiku") >= 0.9);
  assert.ok(similarityScore("gemma-4-e2b", "gemma-4-e2b-it") >= 0.9);
});

test("similarityScore stays below the default threshold for unrelated ids", () => {
  const threshold = 0.72;
  assert.ok(similarityScore("ox", "voxtral-mini-3b-2507") < threshold);
  assert.ok(similarityScore("atria-dawn", "lyria-3-pro-preview") < threshold);
});

test("resolveCandidates requires a shared family below the strong-score bar", () => {
  const index = buildIndex<number>([{ id: "vendor/mimo-2.6-flash", entry: 1 }], "test");
  assert.equal(resolveCandidates(["ling-2.6-flash"], index).match, null, "different families must not match");
  assert.equal(resolveCandidates(["ling-2.6-flash"], index, { threshold: 0.1 }).match, null);
});

test("similarityScore only rewards token-aligned containment", () => {
  assert.equal(similarityScore("mock-model-a", "mock-model-a-mini"), 0.95);
  assert.ok(similarityScore("ox", "voxtral-mini") < 0.72, "mid-token substrings must not count");
  assert.equal(similarityScore("qwen3", "qwen3-next"), 0.95);
});

test("isCompatible rejects differing version numbers", () => {
  assert.equal(isCompatible("mock-model-4-31b", "mock-model-3-12b"), false);
  assert.equal(isCompatible("mock-model-4-31b", "mock-model-4-31b-thinking"), true);
});

test("isCompatible treats one-sided variant tokens as compatible", () => {
  assert.equal(isCompatible("mock-model-opus-4-6-thinking", "mock-model-opus-4-6"), true);
  assert.equal(isCompatible("mock-model-a-mini", "mock-model-a-large"), false);
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
  assert.equal(index.size, 1);
  assert.equal(index.get("mock-model")?.entry, 1);
  assert.equal(index.get("mock-model")?.source, "test");
});

test("buildIndex indexes name-only entries and skips blank keys", () => {
  const index = buildIndex<number>(
    [
      { id: "", name: "Named Model", entry: 1 },
      { id: "  ", name: "   ", entry: 2 },
    ],
    "test",
  );
  assert.equal(index.get("named-model")?.entry, 1);
  assert.equal(index.size, 1);
});

test("resolveCandidates returns exact matches first", () => {
  const index = buildIndex<number>([{ id: "vendor/mock-model", entry: 7 }], "test");
  const result = resolveCandidates(["Mock-Model"], index);
  assert.equal(result.exact?.matched, "Mock-Model");
  assert.equal(result.exact?.entry, 7);
  assert.equal(result.match, null);
});

test("resolveCandidates fuzzy matches compatible typos", () => {
  const index = buildIndex<number>([{ id: "vendor/mock-model-sonnet-x", entry: 1 }], "test");
  const result = resolveCandidates(["mock-model-sonet-x"], index);
  assert.equal(result.exact, null);
  assert.equal(result.match?.entry, 1);
  assert.ok((result.match?.score ?? 0) >= 0.72);
});

test("resolveCandidates respects threshold and compatibility", () => {
  const index = buildIndex<number>([{ id: "vendor/mock-model-sonnet-x", entry: 1 }], "test");
  assert.equal(resolveCandidates(["mock-model-sonnet-y"], index, { threshold: 1 }).match, null);
  const versioned = buildIndex<number>([{ id: "vendor/mock-model-sonnet-4", entry: 1 }], "test");
  assert.equal(resolveCandidates(["mock-model-sonnet-3"], versioned, { threshold: 0.1 }).match, null);
});

test("resolveCandidates ignores empty candidate keys", () => {
  const index = buildIndex<number>([{ id: "mock-model", entry: 1 }], "test");
  const result = resolveCandidates(["", "///"], index);
  assert.equal(result.exact, null);
  assert.equal(result.match, null);
});
