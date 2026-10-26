import { expect, test } from "bun:test";

import { capabilitiesOf } from "~~/lib/model-capabilities";

test("missing model exposes no capabilities", () => {
  expect(capabilitiesOf(undefined)).toEqual({ reasoning: false, vision: false });
  expect(capabilitiesOf({})).toEqual({ reasoning: false, vision: false });
});

test("reasoning is only true when explicitly enabled", () => {
  expect(capabilitiesOf({ reasoning: true }).reasoning).toBe(true);
  expect(capabilitiesOf({ reasoning: false }).reasoning).toBe(false);
});

test("vision requires an image input modality", () => {
  expect(capabilitiesOf({ modalities: { input: ["text", "image"], output: ["text"] } }).vision).toBe(true);
  expect(capabilitiesOf({ modalities: { input: ["text"], output: ["text"] } }).vision).toBe(false);
  expect(capabilitiesOf({ modalities: { input: [], output: [] } }).vision).toBe(false);
});
