import { test } from "node:test";
import assert from "node:assert/strict";

import { compareModelEntries, compareModelIds } from "./model-sort";

test("featured families sort before the Others bucket", () => {
  assert.ok(compareModelIds("claude-opus-4-6", "zzz-unknown-model") < 0);
  assert.ok(compareModelIds("zzz-unknown-model", "claude-opus-4-6") > 0);
});

test("claude tiers order opus before sonnet before haiku", () => {
  const sorted = ["claude-haiku-4-5", "claude-opus-4-6", "claude-sonnet-4-6"].sort(compareModelIds);
  assert.deepEqual(sorted, ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"]);
});

test("newer claude versions sort first", () => {
  const sorted = ["claude-opus-4-5", "claude-opus-4-6"].sort(compareModelIds);
  assert.deepEqual(sorted, ["claude-opus-4-6", "claude-opus-4-5"]);
});

test("newer gpt versions sort first", () => {
  const sorted = ["gpt-5.5", "gpt-5.6"].sort(compareModelIds);
  assert.deepEqual(sorted, ["gpt-5.6", "gpt-5.5"]);
});

test("object entries use the declared family for ranking", () => {
  assert.ok(compareModelEntries({ id: "zzz", family: "Anthropic" }, { id: "aaa", family: "Mistral" }) < 0);
});
