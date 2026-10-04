import { test } from "node:test";
import assert from "node:assert/strict";

import { mergeModelData, splitModelData } from "./merge.ts";
import type { ModelData } from "./types.ts";

test("mergeModelData lets authored fields win over generated", () => {
  const merged = mergeModelData(
    { id: "model", reasoning: true, ignored: true, providers: ["a"] },
    { ignored: false, aliases: ["alias"] },
  );
  assert.equal(merged.reasoning, true);
  assert.equal(merged.ignored, false);
  assert.deepEqual(merged.aliases, ["alias"]);
  assert.deepEqual(merged.providers, ["a"]);
});

test("mergeModelData deep merges provider config with authored winning", () => {
  const merged = mergeModelData(
    { providerConfig: { kiro: { upstream: "claude", contextWindow: 200000 } } },
    { providerConfig: { kiro: { authless: true }, openrouter: { free: true } } },
  );
  assert.deepEqual(merged.providerConfig, {
    kiro: { upstream: "claude", contextWindow: 200000, authless: true },
    openrouter: { free: true },
  });
});

test("mergeModelData unions aliases across halves", () => {
  const merged = mergeModelData({ aliases: ["auto"] }, { aliases: ["curated"] });
  assert.deepEqual(merged.aliases, ["auto", "curated"]);
});

test("mergeModelData handles one-sided and empty input", () => {
  assert.deepEqual(mergeModelData({ id: "a" }, undefined), { id: "a" });
  assert.deepEqual(mergeModelData(undefined, { ignored: true }), { ignored: true });
  assert.deepEqual(mergeModelData(undefined, undefined), {});
  assert.deepEqual(mergeModelData({ providerConfig: {} }, { providerConfig: {} }), {});
});

test("mergeModelData drops empty arrays", () => {
  assert.deepEqual(mergeModelData({ providers: [] }, undefined), {});
  assert.deepEqual(mergeModelData({ aliases: [] }, undefined), {});
  assert.deepEqual(mergeModelData({ providers: ["kiro"] }, undefined).providers, ["kiro"]);
});

test("splitModelData routes fields by ownership", () => {
  const { generated, authored } = splitModelData({
    id: "model",
    providers: ["kiro"],
    reasoning: true,
    limit: { context: 1 },
    ignored: true,
    aliases: ["a"],
    providerConfig: { kiro: { upstream: "u", authless: true } },
  });
  assert.deepEqual(generated, {
    id: "model",
    providers: ["kiro"],
    reasoning: true,
    limit: { context: 1 },
    aliases: ["a"],
    providerConfig: { kiro: { upstream: "u" } },
  });
  assert.deepEqual(authored, {
    ignored: true,
    providerConfig: { kiro: { authless: true } },
  });
});

test("splitModelData drops default ignored flags", () => {
  const { authored } = splitModelData({ providers: ["kiro"], ignored: false });
  assert.deepEqual(authored, {});
  const kept = splitModelData({ ignored: true });
  assert.deepEqual(kept.authored, { ignored: true });
});

test("splitModelData drops empty halves", () => {
  const { generated, authored } = splitModelData({ providers: ["kiro"] });
  assert.deepEqual(generated, { providers: ["kiro"] });
  assert.deepEqual(authored, {});

  const other = splitModelData({ ignored: true });
  assert.deepEqual(other.generated, {});
  assert.deepEqual(other.authored, { ignored: true });
});

test("splitModelData round-trips through mergeModelData", () => {
  const original: ModelData = {
    id: "model",
    providers: ["kiro", "openrouter"],
    reasoning: true,
    limit: { context: 200000 },
    ignored: true,
    providerConfig: {
      kiro: { upstream: "u", contextWindow: 1, authless: true },
      openrouter: { free: true },
    },
  };
  const { generated, authored } = splitModelData(original);
  assert.deepEqual(mergeModelData(generated, authored), original);
});
