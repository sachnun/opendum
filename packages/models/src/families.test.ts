import { test } from "node:test";
import assert from "node:assert/strict";

import { FAMILY_RULES, inferFamilyFromFolder, inferModelFolder } from "./families.ts";

test("inferModelFolder maps known model prefixes to folders", () => {
  const cases: Array<[string, string]> = [
    ["claude-opus-4-6", "anthropic"],
    ["gpt-5.5", "openai"],
    ["o3-mini", "openai"],
    ["gemini-3-pro", "google"],
    ["gemma-3-27b", "google"],
    ["grok-4", "xai"],
    ["llama-4-scout", "meta"],
    ["qwen3-32b", "qwen"],
    ["deepseek-v3", "deepseek"],
    ["kimi-k2", "moonshot"],
    ["minimax-m2", "minimax"],
    ["glm-4.6", "z-ai"],
    ["mistral-large-3", "mistral"],
    ["nemotron-4", "nvidia"],
    ["granite-4", "ibm"],
  ];
  for (const [model, folder] of cases) {
    assert.equal(inferModelFolder(model), folder, `inferModelFolder(${model})`);
  }
});

test("inferModelFolder is case-insensitive and returns null when unknown", () => {
  assert.equal(inferModelFolder("CLAUDE-OPUS-4-6"), "anthropic");
  assert.equal(inferModelFolder("some-unknown-model"), null);
});

test("inferFamilyFromFolder resolves folders declared by rules", () => {
  assert.equal(inferFamilyFromFolder("anthropic"), "Anthropic");
  assert.equal(inferFamilyFromFolder("google"), "Google");
  assert.equal(inferFamilyFromFolder("does-not-exist"), null);
  assert.equal(inferFamilyFromFolder(null), null);
  assert.equal(inferFamilyFromFolder(undefined), null);
});

test("FAMILY_RULES folders are unique enough to map deterministically", () => {
  for (const rule of FAMILY_RULES) {
    assert.ok(rule.test instanceof RegExp);
    assert.ok(rule.folder.length > 0);
    assert.ok(rule.family.length > 0);
  }
});
