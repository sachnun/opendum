import { expect, test } from "bun:test";

import { mergeModelData, splitModelData } from "./merge.ts";
import type { ModelData } from "../types.ts";

test("mergeModelData lets authored fields win over generated", () => {
  const merged = mergeModelData(
    { id: "model", reasoning: true, ignored: true, providers: ["a"] },
    { ignored: false, aliases: ["alias"] },
  );
  expect(merged.reasoning).toBe(true);
  expect(merged.ignored).toBe(false);
  expect(merged.aliases).toEqual(["alias"]);
  expect(merged.providers).toEqual(["a"]);
});

test("mergeModelData deep merges provider config with authored winning", () => {
  const merged = mergeModelData(
    { providerConfig: { kiro: { upstream: "claude", contextWindow: 200000 } } },
    { providerConfig: { kiro: { authless: true }, openrouter: { free: true } } },
  );
  expect(merged.providerConfig).toEqual({
    kiro: { upstream: "claude", contextWindow: 200000, authless: true },
    openrouter: { free: true },
  });
});

test("mergeModelData unions aliases across halves", () => {
  const merged = mergeModelData({ aliases: ["auto"] }, { aliases: ["curated"] });
  expect(merged.aliases).toEqual(["auto", "curated"]);
});

test("mergeModelData handles one-sided and empty input", () => {
  expect(mergeModelData({ id: "a" }, undefined)).toEqual({ id: "a" });
  expect(mergeModelData(undefined, { ignored: true })).toEqual({ ignored: true });
  expect(mergeModelData(undefined, undefined)).toEqual({});
  expect(mergeModelData({ providerConfig: {} }, { providerConfig: {} })).toEqual({});
});

test("mergeModelData drops empty arrays", () => {
  expect(mergeModelData({ providers: [] }, undefined)).toEqual({});
  expect(mergeModelData({ aliases: [] }, undefined)).toEqual({});
  expect(mergeModelData({ providers: ["kiro"] }, undefined).providers).toEqual(["kiro"]);
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

test("splitModelData drops default ignored flags", () => {
  const { authored } = splitModelData({ providers: ["kiro"], ignored: false });
  expect(authored).toEqual({});
  const kept = splitModelData({ ignored: true });
  expect(kept.authored).toEqual({ ignored: true });
});

test("splitModelData drops empty halves", () => {
  const { generated, authored } = splitModelData({ providers: ["kiro"] });
  expect(generated).toEqual({ providers: ["kiro"] });
  expect(authored).toEqual({});

  const other = splitModelData({ ignored: true });
  expect(other.generated).toEqual({});
  expect(other.authored).toEqual({ ignored: true });
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
  expect(mergeModelData(generated, authored)).toEqual(original);
});
