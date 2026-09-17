import { test } from "node:test";
import assert from "node:assert/strict";

import { FAMILY_RULES, inferFamilyFromFolder, inferModelFolder } from "./families.ts";

test("inferModelFolder maps mocked prefix names to rule folders", () => {
  const cases: Array<[string, string]> = [
    ["claude-mock", "anthropic"],
    ["gpt-mock", "openai"],
    ["gemini-mock", "google"],
    ["grok-mock", "xai"],
    ["llama-mock", "meta"],
    ["qwen-mock", "qwen"],
    ["deepseek-mock", "deepseek"],
    ["kimi-mock", "moonshot"],
    ["minimax-mock", "minimax"],
    ["glm-mock", "z-ai"],
    ["mistral-mock", "mistral"],
    ["nemotron-mock", "nvidia"],
    ["granite-mock", "ibm"],
  ];
  for (const [model, folder] of cases) {
    assert.equal(inferModelFolder(model), folder, `inferModelFolder(${model})`);
  }
});

test("inferModelFolder is case-insensitive and returns null when unknown", () => {
  assert.equal(inferModelFolder("CLAUDE-MOCK"), "anthropic");
  assert.equal(inferModelFolder("mock-unknown-model"), null);
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
