import { expect, test } from "bun:test";

import { modelPatch, type ModelMetadataInput, type ResolvedMetadata } from "./metadata.ts";

function efforts(values: string[]): unknown {
  return { reasoning_options: [{ type: "effort", values }] };
}

function input(providers: string[]): ModelMetadataInput {
  return { id: "deepseek-v4.1-flash", candidates: ["deepseek-v4.1-flash"], providers };
}

test("reasoning effort unions provider declarations instead of taking the first", () => {
  const resolved: ResolvedMetadata = {
    perProvider: {
      hyper: { source: "modelsdev", id: "deepseek-v4.1-flash", entry: efforts(["low", "high", "xhigh"]) },
      zenmux: { source: "modelsdev", id: "deepseek/deepseek-v4.1-flash", entry: efforts(["low", "high", "max"]) },
    },
    global: {},
  };

  const patch = modelPatch(input(["hyper", "zenmux"]), resolved);
  expect(patch.reasoningEffort).toEqual(["low", "high", "xhigh", "max"]);
});

test("reasoning effort keeps canonical order across overlapping providers", () => {
  const resolved: ResolvedMetadata = {
    perProvider: {
      opencode: { source: "modelsdev", id: "deepseek-v4.1-flash", entry: efforts(["low", "high", "max"]) },
      zenmux: { source: "modelsdev", id: "deepseek/deepseek-v4.1-flash", entry: efforts(["low", "medium", "high"]) },
    },
    global: {},
  };

  const patch = modelPatch(input(["opencode", "zenmux"]), resolved);
  expect(patch.reasoningEffort).toEqual(["low", "medium", "high", "max"]);
});

test("reasoning effort falls back to a global hit when no provider declares one", () => {
  const resolved: ResolvedMetadata = {
    perProvider: {},
    global: {
      openrouter: {
        source: "openrouter",
        id: "deepseek/deepseek-v4.1-flash",
        entry: { reasoning: { supported_efforts: ["none", "low", "high", "max"] } },
      },
    },
  };

  const patch = modelPatch(input(["hyper"]), resolved);
  expect(patch.reasoningEffort).toEqual(["low", "high", "max"]);
});

test("reasoning effort stays null when no source declares efforts", () => {
  const resolved: ResolvedMetadata = {
    perProvider: { hyper: { source: "modelsdev", id: "deepseek-v4.1-flash", entry: { reasoning: true } } },
    global: {},
  };

  const patch = modelPatch(input(["hyper"]), resolved);
  expect(patch.reasoningEffort).toBeNull();
});
