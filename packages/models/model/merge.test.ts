import { expect, test } from "bun:test";

import { mergeData, splitData } from "@opendum/models/model/merge";
import type { ModelData } from "@opendum/models/types";

test("mergeData lets authored fields win over generated", () => {
  const merged = mergeData(
    { id: "model", reasoning: true, ignored: true, providers: ["a"] },
    { ignored: false, aliases: ["alias"] },
  );
  expect(merged.reasoning).toBe(true);
  expect(merged.ignored).toBe(false);
  expect(merged.aliases).toEqual(["alias"]);
  expect(merged.providers).toEqual(["a"]);
});

test("mergeData deep merges provider config with authored winning", () => {
  const merged = mergeData(
    { providerConfig: { kiro: { upstream: "claude", contextWindow: 200000 } } },
    { providerConfig: { kiro: { authless: true }, openrouter: { free: true } } },
  );
  expect(merged.providerConfig).toEqual({
    kiro: { upstream: "claude", contextWindow: 200000, authless: true },
    openrouter: { free: true },
  });
});

test("mergeData unions aliases across halves", () => {
  const merged = mergeData({ aliases: ["auto"] }, { aliases: ["curated"] });
  expect(merged.aliases).toEqual(["auto", "curated"]);
});

test("mergeData handles one-sided and empty input", () => {
  expect(mergeData({ id: "a" }, undefined)).toEqual({ id: "a" });
  expect(mergeData(undefined, { ignored: true })).toEqual({ ignored: true });
  expect(mergeData(undefined, undefined)).toEqual({});
  expect(mergeData({ providerConfig: {} }, { providerConfig: {} })).toEqual({});
});

test("mergeData drops empty arrays", () => {
  expect(mergeData({ providers: [] }, undefined)).toEqual({});
  expect(mergeData({ aliases: [] }, undefined)).toEqual({});
  expect(mergeData({ providers: ["kiro"] }, undefined).providers).toEqual(["kiro"]);
});

test("splitData routes fields by ownership", () => {
  const { generated, authored } = splitData({
    id: "model",
    providers: ["kiro"],
    reasoning: true,
    limit: { context: 1 },
    ignored: true,
    aliases: ["a"],
    providerConfig: { kiro: { upstream: "u", authless: true } },
  });
  expect(generated).toEqual({
    id: "model",
    providers: ["kiro"],
    reasoning: true,
    limit: { context: 1 },
    aliases: ["a"],
    providerConfig: { kiro: { upstream: "u" } },
  });
  expect(authored).toEqual({
    ignored: true,
    providerConfig: { kiro: { authless: true } },
  });
});

test("splitData drops default ignored flags", () => {
  const { authored } = splitData({ providers: ["kiro"], ignored: false });
  expect(authored).toEqual({});
  const kept = splitData({ ignored: true });
  expect(kept.authored).toEqual({ ignored: true });
});

test("splitData drops empty halves", () => {
  const { generated, authored } = splitData({ providers: ["kiro"] });
  expect(generated).toEqual({ providers: ["kiro"] });
  expect(authored).toEqual({});

  const other = splitData({ ignored: true });
  expect(other.generated).toEqual({});
  expect(other.authored).toEqual({ ignored: true });
});

test("splitData round-trips through mergeData", () => {
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
  const { generated, authored } = splitData(original);
  expect(mergeData(generated, authored)).toEqual(original);
});
