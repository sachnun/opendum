import { test } from "node:test";
import assert from "node:assert/strict";

import { modelProbeSets, modelProbes } from "#models/model/probes.ts";

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
  assert.deepEqual([...probes].sort(), [
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
  assert.deepEqual([...probes].sort(), ["file-id", "real"]);
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
  assert.deepEqual([...core].sort(), [
    "@cf/meta/llama-3.1-8b-instruct-fp8",
    "llama-3.1",
    "llama-3.1-8b-instruct-fp8",
  ]);
  assert.deepEqual([...aliases].sort(), ["llama-3.1-70b-instruct", "llama-3.1-8b-instruct"]);
});

test("modelProbeSets does not repeat core values as aliases", () => {
  const { core, aliases } = modelProbeSets({
    id: "gemma-3",
    fileId: "gemma-3",
    data: { aliases: ["gemma-3", "google/gemma-3-12b-it"] },
  });
  assert.equal(core.has("gemma-3"), true);
  assert.deepEqual([...aliases], ["google/gemma-3-12b-it"]);
});
