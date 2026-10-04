import { test } from "node:test";
import assert from "node:assert/strict";

import { getEffectiveModelCapabilities } from "./model-capabilities";

test("missing model exposes no capabilities", () => {
  assert.deepEqual(getEffectiveModelCapabilities(undefined), { reasoning: false, vision: false });
  assert.deepEqual(getEffectiveModelCapabilities({}), { reasoning: false, vision: false });
});

test("reasoning is only true when explicitly enabled", () => {
  assert.equal(getEffectiveModelCapabilities({ reasoning: true }).reasoning, true);
  assert.equal(getEffectiveModelCapabilities({ reasoning: false }).reasoning, false);
});

test("vision requires an image input modality", () => {
  assert.equal(
    getEffectiveModelCapabilities({ modalities: { input: ["text", "image"], output: ["text"] } }).vision,
    true,
  );
  assert.equal(
    getEffectiveModelCapabilities({ modalities: { input: ["text"], output: ["text"] } }).vision,
    false,
  );
  assert.equal(getEffectiveModelCapabilities({ modalities: { input: [], output: [] } }).vision, false);
});
