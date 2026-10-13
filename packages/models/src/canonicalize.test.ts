import { expect, test } from "bun:test";

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
  expect(plan.actions.length).toBe(1);
  const [action] = plan.actions;
  expect(action.kind).toBe("rename");
  expect(action.from).toBe("nemotron-3-ultra");
  expect(action.to).toBe("nemotron-3-ultra-550b-a55b");
  expect(action.tier).toBe("exact");
});

test("planCanonicalization leaves an already-canonical model untouched", () => {
  const plan = planCanonicalization([model("deepseek-v4-flash", { providers: ["openrouter"] })], index());
  expect(plan.actions.length).toBe(0);
  expect(plan.unresolved.length).toBe(0);
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
  expect(merges.length).toBe(1);
  const [merge] = merges;
  expect(merge.from).toBe("deepseek-v4-flash-fast");
  expect(merge.to).toBe("deepseek-v4-flash");
  expect(merge.data.providers).toEqual(["example"]);
  expect(merge.aliases).toEqual(["deepseek-v4-flash-fast"]);
});

test("planCanonicalization renames then merges in the same pass", () => {
  const plan = planCanonicalization(
    [
      model("gemma-4", { providers: ["perch"] }),
      model("gemma-4-31b", { providers: ["nvidia_nim"] }),
    ],
    index(),
  );
  expect(plan.actions.length).toBe(1);
  expect(plan.actions[0].kind).toBe("rename");
  expect(plan.actions[0].to).toBe("gemma-4-31b-it");
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
  expect(plan.unresolved).toEqual([]);
  const rename = plan.actions.find((action) => action.kind === "rename");
  const merge = plan.actions.find((action) => action.kind === "merge");
  expect(rename?.to).toBe("MiniMax-M2.7");
  expect(merge?.from).toBe("minimax-m2.7-free");
  expect(merge?.to).toBe("MiniMax-M2.7");
});

test("planCanonicalization reports unresolvable models", () => {
  const plan = planCanonicalization([model("totally-private-model", { providers: ["x"] })], index());
  expect(plan.actions.length).toBe(0);
  expect(plan.unresolved).toEqual(["totally-private-model"]);
});

test("planCanonicalization fails closed on an ambiguous canonical id", () => {
  const plan = planCanonicalization([model("gemma-4", { providers: ["perch"] })], index());
  expect(plan.actions.length).toBe(0);
  expect(plan.unresolved).toEqual(["gemma-4"]);
});

test("planCanonicalization does not rename a model onto an occupied id", () => {
  const plan = planCanonicalization(
    [
      model("nemotron-3-ultra-550b-a55b", { providers: ["nvidia_nim"] }),
      model("nemotron-3-ultra", { providers: ["opencode"] }),
    ],
    index(),
  );
  expect(plan.actions.length).toBe(1);
  expect(plan.actions[0].kind).toBe("merge");
  expect(plan.actions[0].to).toBe("nemotron-3-ultra-550b-a55b");
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
  expect(target.providers).toEqual(["example", "openrouter"]);
  expect(target.aliases).toEqual(["deepseek-v4-flash-fast", "ds-flash"]);
  expect(target.providerConfig?.openrouter?.upstream).toBe("deepseek/deepseek-v4-flash");
  expect(target.providerConfig?.example?.upstream).toBe("deepseek/deepseek-v4-flash-fast");
  expect(target.providerConfig?.example?.free).toBe(true);
  expect(target.id).toBe("deepseek-v4-flash");
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
  expect(target.providerConfig?.openrouter?.upstream).toBe("old");
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
      scores: { artificialAnalysis: { index: 23.9, estimated: true } },
    },
    aliases: ["mimo-omni"],
  });

  expect(target.reasoning).toBe(true);
  expect(target.reasoning_effort).toEqual(["low", "high"]);
  expect(target.limit).toEqual({ context: 200000, output: 65536 });
  expect(target.cost).toEqual({ input: 0.5, output: 1 });
  expect(target.scores?.artificialAnalysis?.index).toBe(23.9);
  expect(target.providers).toEqual(["example", "openrouter"]);
  expect(target.id).toBe("mimo-v2-omni");
});

test("applyCanonicalMerge does not let a merged duplicate outrank the target score", () => {
  const target: ModelData = {
    id: "model",
    scores: { artificialAnalysis: { index: 40, estimated: false } },
  };
  applyCanonicalMerge(target, {
    kind: "merge",
    relativeId: "variant",
    fileId: "variant",
    path: "/models/variant.json",
    from: "variant",
    to: "model",
    tier: "exact",
    data: { scores: { artificialAnalysis: { index: 12, estimated: true } } },
    aliases: [],
  });
  expect(target.scores?.artificialAnalysis?.index).toBe(40);
});
