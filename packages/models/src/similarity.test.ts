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
} from "./similarity.ts";

test("normalizeName strips provider prefix, suffixes and separators", () => {
  assert.equal(normalizeName("openai/GPT-4o:free"), "gpt-4o");
  assert.equal(normalizeName("anthropic/claude_sonnet.4"), "claude-sonnet-4");
  assert.equal(normalizeName("  vendor/model--variant  "), "model-variant");
  assert.equal(normalizeName(null), "");
  assert.equal(normalizeName(undefined), "");
});

test("normalizeName strips batch and thinking suffixes", () => {
  assert.equal(normalizeName("openai/gpt-4o:batch"), "gpt-4o");
  assert.equal(normalizeName("vendor/claude-opus:thinking"), "claude-opus");
});

test("stripDateSuffix only removes 4-8 digit trailing tokens", () => {
  assert.equal(stripDateSuffix("claude-opus-4-20250514"), "claude-opus-4");
  assert.equal(stripDateSuffix("model-0813"), "model");
  assert.equal(stripDateSuffix("gpt-4"), "gpt-4");
  assert.equal(stripDateSuffix("20250514"), "20250514");
});

test("normalizeKey combines normalization and date stripping", () => {
  assert.equal(normalizeKey("openai/gpt-4o-20240101"), "gpt-4o");
});

test("similarityScore is exact for equal and high for containment", () => {
  assert.equal(similarityScore("gemma-4-31b", "gemma-4-31b"), 1);
  assert.equal(similarityScore("gpt-4o", "gpt-4o-mini"), 0.95);
  assert.ok(similarityScore("claude-sonet-4", "claude-sonnet-4") > 0.9);
  assert.ok(similarityScore("totally-unrelated", "claude-sonnet-4") < 0.5);
});

test("isCompatible rejects differing version numbers", () => {
  assert.equal(isCompatible("gemma-4-31b", "gemma-3-12b"), false);
  assert.equal(isCompatible("gemma-4-31b", "gemma-4-31b-thinking"), true);
});

test("isCompatible treats one-sided variant tokens as compatible", () => {
  assert.equal(isCompatible("claude-opus-4-6-thinking", "claude-opus-4-6"), true);
  assert.equal(isCompatible("gpt-4o-mini", "gpt-4o-large"), false);
});

test("buildIndex deduplicates by normalized key keeping the first entry", () => {
  const index = buildIndex<number>(
    [
      { id: "openai/gpt-4o", entry: 1 },
      { id: "gpt-4o", entry: 2 },
      { id: "gpt-4o-20240101", entry: 3 },
    ],
    "test",
  );
  assert.equal(index.size, 1);
  assert.equal(index.get("gpt-4o")?.entry, 1);
  assert.equal(index.get("gpt-4o")?.source, "test");
});

test("resolveCandidates returns exact matches first", () => {
  const index = buildIndex<number>([{ id: "openai/gpt-4o", entry: 7 }], "test");
  const result = resolveCandidates(["GPT-4o"], index);
  assert.equal(result.exact?.matched, "GPT-4o");
  assert.equal(result.exact?.entry, 7);
  assert.equal(result.match, null);
});

test("resolveCandidates fuzzy matches compatible typos", () => {
  const index = buildIndex<number>([{ id: "anthropic/claude-sonnet-4", entry: 1 }], "test");
  const result = resolveCandidates(["claude-sonet-4"], index);
  assert.equal(result.exact, null);
  assert.equal(result.match?.entry, 1);
  assert.ok((result.match?.score ?? 0) >= 0.72);
});

test("resolveCandidates respects threshold and compatibility", () => {
  const index = buildIndex<number>([{ id: "anthropic/claude-sonnet-4", entry: 1 }], "test");
  assert.equal(resolveCandidates(["claude-sonnet-4"], index, { threshold: 1 }).match, null);
  const incompatible = resolveCandidates(["claude-sonnet-3"], index, { threshold: 0.1 });
  assert.equal(incompatible.match, null);
});

test("resolveCandidates ignores empty candidate keys", () => {
  const index = buildIndex<number>([{ id: "gpt-4o", entry: 1 }], "test");
  const result = resolveCandidates(["", "///"], index);
  assert.equal(result.exact, null);
  assert.equal(result.match, null);
});
