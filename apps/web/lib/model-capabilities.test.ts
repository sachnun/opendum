import { expect, test } from "bun:test";

import { getEffectiveModelCapabilities } from "./model-capabilities";

test("missing model exposes no capabilities", () => {
  expect(getEffectiveModelCapabilities(undefined)).toEqual({ reasoning: false, vision: false });
  expect(getEffectiveModelCapabilities({})).toEqual({ reasoning: false, vision: false });
});

test("reasoning is only true when explicitly enabled", () => {
  expect(getEffectiveModelCapabilities({ reasoning: true }).reasoning).toBe(true);
  expect(getEffectiveModelCapabilities({ reasoning: false }).reasoning).toBe(false);
});

test("vision requires an image input modality", () => {
  expect(getEffectiveModelCapabilities({ modalities: { input: ["text", "image"], output: ["text"] } }).vision).toBe(true);
  expect(getEffectiveModelCapabilities({ modalities: { input: ["text"], output: ["text"] } }).vision).toBe(false);
  expect(getEffectiveModelCapabilities({ modalities: { input: [], output: [] } }).vision).toBe(false);
});
