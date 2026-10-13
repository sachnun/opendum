import { expect, test } from "bun:test";

import { modelProbeSets, modelProbes } from "./probes.ts";

test("modelProbes collects id, fileId, aliases and upstreams", () => {
  const probes = modelProbes({
    id: "model-id",
    fileId: "file-id",
    data: {
      aliases: ["alias-a", "alias-b"],
      providerConfig: {
        openrouter: { upstream: "vendor/model" },
        nvidia_nim: { upstream: "plain-name" },
      },
    },
  });
  expect([...probes].sort()).toEqual([
    "alias-a",
    "alias-b",
    "file-id",
    "model",
    "model-id",
    "plain-name",
    "vendor/model",
  ]);
});

test("modelProbes drops blank candidates", () => {
  const probes = modelProbes({
    id: "",
    fileId: "file-id",
    data: { aliases: ["", "  ", "real"], providerConfig: { p: { upstream: "  " } } },
  });
  expect([...probes].sort()).toEqual(["file-id", "real"]);
});

test("modelProbeSets keeps historical aliases out of core", () => {
  const { core, aliases } = modelProbeSets({
    id: "llama-3.1",
    fileId: "llama-3.1",
    data: {
      aliases: ["llama-3.1-70b-instruct", "llama-3.1-8b-instruct"],
      providerConfig: { workers_ai: { upstream: "@cf/meta/llama-3.1-8b-instruct-fp8" } },
    },
  });
  expect([...core].sort()).toEqual([
    "@cf/meta/llama-3.1-8b-instruct-fp8",
    "llama-3.1",
    "llama-3.1-8b-instruct-fp8",
  ]);
  expect([...aliases].sort()).toEqual(["llama-3.1-70b-instruct", "llama-3.1-8b-instruct"]);
});

test("modelProbeSets does not repeat core values as aliases", () => {
  const { core, aliases } = modelProbeSets({
    id: "gemma-3",
    fileId: "gemma-3",
    data: { aliases: ["gemma-3", "google/gemma-3-12b-it"] },
  });
  expect(core.has("gemma-3")).toBe(true);
  expect([...aliases]).toEqual(["google/gemma-3-12b-it"]);
});
