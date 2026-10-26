import { expect, test } from "bun:test";

import { FAMILY_RULES, familyOf, folderOf } from "./families.ts";

test("folderOf maps mocked prefix names to rule folders", () => {
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
    expect(folderOf(model), `folderOf(${model})`).toBe(folder);
  }
});

test("folderOf is case-insensitive and returns null when unknown", () => {
  expect(folderOf("CLAUDE-MOCK")).toBe("anthropic");
  expect(folderOf("mock-unknown-model")).toBe(null);
});

test("familyOf resolves folders declared by rules", () => {
  expect(familyOf("anthropic")).toBe("Anthropic");
  expect(familyOf("google")).toBe("Google");
  expect(familyOf("does-not-exist")).toBe(null);
  expect(familyOf(null)).toBe(null);
  expect(familyOf(undefined)).toBe(null);
});

test("FAMILY_RULES folders are unique enough to map deterministically", () => {
  for (const rule of FAMILY_RULES) {
    expect(rule.test instanceof RegExp).toBeTruthy();
    expect(rule.folder.length > 0).toBeTruthy();
    expect(rule.family.length > 0).toBeTruthy();
  }
});
