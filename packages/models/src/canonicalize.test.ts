import { test } from "node:test";
import assert from "node:assert/strict";

import { buildCanonicalIndex } from "./canonical.ts";
import {
  applyCanonicalMerge,
  planCanonicalization,
  type CanonicalMerge,
  type CanonicalizationModel,
} from "./canonicalize.ts";
import type { ModelData } from "./types.ts";

function index() {
  return buildCanonicalIndex({
    models: {
      "deepseek/deepseek-v4-flash": { name: "DeepSeek V4 Flash" },
      "deepseek/deepseek-v4.1-flash": { name: "DeepSeek V4.1 Flash" },
      "nvidia/nemotron-3-ultra-550b-a55b": { name: "Nemotron 3 Ultra" },
      "google/gemma-4-31b-it": { name: "Gemma 4 31B" },
      "google/gemma-4-12b-it": { name: "Gemma 4 12B" },
    },
    providers: {
      deepseek: {
        models: {
          "deepseek-v4-flash-fast": { canonical_model_id: "deepseek/deepseek-v4-flash" },
          "deepseek-v4-flash": { canonical_model_id: "deepseek/deepseek-v4.1-flash" },
        },
      },
    },
  });
}

function model(fileId: string, data: ModelData = {}): CanonicalizationModel {
  return { relativeId: fileId, fileId, path: `/models/${fileId}.json`, data };
}

test("planCanonicalization renames a model to its canonical id", () => {
  const plan = planCanonicalization(
    [model("nemotron-3-ultra", { providers: ["nvidia_nim"], providerConfig: { nvidia_nim: { upstream: "nvidia/nemotron-3-ultra-550b-a55b" } } })],
    index(),
  );
  assert.equal(plan.actions.length, 1);
  const [action] = plan.actions;
  assert.equal(action.kind, "rename");
  assert.equal(action.from, "nemotron-3-ultra");
  assert.equal(action.to, "nemotron-3-ultra-550b-a55b");
  assert.equal(action.tier, "exact");
});

test("planCanonicalization leaves an already-canonical model untouched", () => {
  const plan = planCanonicalization([model("deepseek-v4-flash", { providers: ["openrouter"] })], index());
  assert.equal(plan.actions.length, 0);
  assert.equal(plan.unresolved.length, 0);
});

test("planCanonicalization merges a provider variant into the canonical model", () => {
  const plan = planCanonicalization(
    [
      model("deepseek-v4-flash", { providers: ["openrouter"] }),
      model("deepseek-v4-flash-fast", {
        providers: ["example"],
        providerConfig: { example: { upstream: "deepseek/deepseek-v4-flash-fast" } },
      }),
    ],
    index(),
  );
  const merges = plan.actions.filter((action) => action.kind === "merge");
  assert.equal(merges.length, 1);
  const [merge] = merges;
  assert.equal(merge.from, "deepseek-v4-flash-fast");
  assert.equal(merge.to, "deepseek-v4-flash");
  assert.deepEqual(merge.data.providers, ["example"]);
  assert.deepEqual(merge.aliases, ["deepseek-v4-flash-fast"]);
});

test("planCanonicalization renames then merges in the same pass", () => {
  const plan = planCanonicalization(
    [
      model("gemma-4", { providers: ["perch"] }),
      model("gemma-4-31b", { providers: ["nvidia_nim"] }),
    ],
    index(),
  );
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0].kind, "rename");
  assert.equal(plan.actions[0].to, "gemma-4-31b-it");
});

test("planCanonicalization merges variants onto a shared canonical id that has no file", () => {
  const plan = planCanonicalization(
    [
      model("minimax-m2.7", { providers: ["zenmux"] }),
      model("minimax-m2.7-free", { providers: ["opencode"] }),
    ],
    buildCanonicalIndex({
      models: { "minimax/MiniMax-M2.7": { name: "MiniMax M2.7" } },
    }),
  );
  assert.deepEqual(plan.unresolved, []);
  const rename = plan.actions.find((action) => action.kind === "rename");
  const merge = plan.actions.find((action) => action.kind === "merge");
  assert.equal(rename?.to, "MiniMax-M2.7");
  assert.equal(merge?.from, "minimax-m2.7-free");
  assert.equal(merge?.to, "MiniMax-M2.7");
});

test("planCanonicalization reports unresolvable models", () => {
  const plan = planCanonicalization([model("totally-private-model", { providers: ["x"] })], index());
  assert.equal(plan.actions.length, 0);
  assert.deepEqual(plan.unresolved, ["totally-private-model"]);
});

test("planCanonicalization fails closed on an ambiguous canonical id", () => {
  const plan = planCanonicalization([model("gemma-4", { providers: ["perch"] })], index());
  assert.equal(plan.actions.length, 0);
  assert.deepEqual(plan.unresolved, ["gemma-4"]);
});

test("planCanonicalization does not rename a model onto an occupied id", () => {
  const plan = planCanonicalization(
    [
      model("nemotron-3-ultra-550b-a55b", { providers: ["nvidia_nim"] }),
      model("nemotron-3-ultra", { providers: ["opencode"] }),
    ],
    index(),
  );
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0].kind, "merge");
  assert.equal(plan.actions[0].to, "nemotron-3-ultra-550b-a55b");
});

test("applyCanonicalMerge folds providers, config and aliases", () => {
  const target: ModelData = {
    id: "deepseek-v4-flash",
    providers: ["openrouter"],
    aliases: ["ds-flash"],
    providerConfig: { openrouter: { upstream: "deepseek/deepseek-v4-flash" } },
  };
  const merge: CanonicalMerge = {
    kind: "merge",
    relativeId: "deepseek-v4-flash-fast",
    fileId: "deepseek-v4-flash-fast",
    path: "/models/deepseek-v4-flash-fast.json",
    from: "deepseek-v4-flash-fast",
    to: "deepseek-v4-flash",
    tier: "exact",
    data: {
      providers: ["example"],
      providerConfig: { example: { upstream: "deepseek/deepseek-v4-flash-fast", free: true } },
    },
    aliases: ["deepseek-v4-flash-fast"],
  };

  applyCanonicalMerge(target, merge);
  assert.deepEqual(target.providers, ["example", "openrouter"]);
  assert.deepEqual(target.aliases, ["deepseek-v4-flash-fast", "ds-flash"]);
  assert.equal(target.providerConfig?.openrouter?.upstream, "deepseek/deepseek-v4-flash");
  assert.equal(target.providerConfig?.example?.upstream, "deepseek/deepseek-v4-flash-fast");
  assert.equal(target.providerConfig?.example?.free, true);
  assert.equal(target.id, "deepseek-v4-flash");
});

test("applyCanonicalMerge keeps the canonical provider config on conflict", () => {
  const target: ModelData = {
    id: "model",
    providers: ["openrouter"],
    providerConfig: { openrouter: { upstream: "old" } },
  };
  applyCanonicalMerge(target, {
    kind: "merge",
    relativeId: "variant",
    fileId: "variant",
    path: "/models/variant.json",
    from: "variant",
    to: "model",
    tier: "exact",
    data: { providers: ["openrouter"], providerConfig: { openrouter: { upstream: "new" } } },
    aliases: [],
  });
  assert.equal(target.providerConfig?.openrouter?.upstream, "old");
});

test("applyCanonicalMerge carries generated fields the target is missing", () => {
  const target: ModelData = {
    id: "mimo-v2-omni",
    providers: ["openrouter"],
    limit: { context: 200000 },
  };
  applyCanonicalMerge(target, {
    kind: "merge",
    relativeId: "mimo-omni",
    fileId: "mimo-omni",
    path: "/models/mimo-omni.json",
    from: "mimo-omni",
    to: "mimo-v2-omni",
    tier: "exact",
    data: {
      providers: ["example"],
      reasoning: true,
      reasoning_effort: ["low", "high"],
      modalities: { input: ["text", "image"], output: ["text"] },
      limit: { context: 1000000, output: 65536 },
      cost: { input: 0.5, output: 1 },
      scores: { artificialAnalysis: { index: 23.9, estimated: true, version: "4.3" } },
    },
    aliases: ["mimo-omni"],
  });

  assert.equal(target.reasoning, true);
  assert.deepEqual(target.reasoning_effort, ["low", "high"]);
  assert.deepEqual(target.limit, { context: 200000, output: 65536 });
  assert.deepEqual(target.cost, { input: 0.5, output: 1 });
  assert.equal(target.scores?.artificialAnalysis?.index, 23.9);
  assert.deepEqual(target.providers, ["example", "openrouter"]);
  assert.equal(target.id, "mimo-v2-omni");
});

test("applyCanonicalMerge does not let a merged duplicate outrank the target score", () => {
  const target: ModelData = {
    id: "model",
    scores: { artificialAnalysis: { index: 40, estimated: false, version: "4.3" } },
  };
  applyCanonicalMerge(target, {
    kind: "merge",
    relativeId: "variant",
    fileId: "variant",
    path: "/models/variant.json",
    from: "variant",
    to: "model",
    tier: "exact",
    data: { scores: { artificialAnalysis: { index: 12, estimated: true, version: "4.3" } } },
    aliases: [],
  });
  assert.equal(target.scores?.artificialAnalysis?.index, 40);
});
