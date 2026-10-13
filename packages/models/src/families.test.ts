import { expect, test } from "bun:test";

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
    expect(inferModelFolder(model), `inferModelFolder(${model})`).toBe(folder);
  }
});

test("inferModelFolder is case-insensitive and returns null when unknown", () => {
  expect(inferModelFolder("CLAUDE-MOCK")).toBe("anthropic");
  expect(inferModelFolder("mock-unknown-model")).toBe(null);
});

test("inferFamilyFromFolder resolves folders declared by rules", () => {
  expect(inferFamilyFromFolder("anthropic")).toBe("Anthropic");
  expect(inferFamilyFromFolder("google")).toBe("Google");
  expect(inferFamilyFromFolder("does-not-exist")).toBe(null);
  expect(inferFamilyFromFolder(null)).toBe(null);
  expect(inferFamilyFromFolder(undefined)).toBe(null);
});

test("FAMILY_RULES folders are unique enough to map deterministically", () => {
  for (const rule of FAMILY_RULES) {
    expect(rule.test instanceof RegExp).toBeTruthy();
    expect(rule.folder.length > 0).toBeTruthy();
    expect(rule.family.length > 0).toBeTruthy();
  }
});
