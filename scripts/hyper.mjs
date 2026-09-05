#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildModelIndex, syncProviderModels, writeModelJson } from "./model-registry.mjs";
import { fetchJson } from "./lib/shared.mjs";
import { stripParamInfoKey } from "./lib/clean-key.mjs";

const PROVIDER_NAME = "hyper";
const HYPER_MODELS_URL = "https://hyper.charm.land/v1/models";

const MIN_EXPECTED_MODELS = 10;

function toModelKey(modelId) {
  const normalized = modelId
    .replace(/[:/]/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-{2,}/g, "-");

  return stripParamInfoKey(normalized);
}

function fullModelKey(modelId) {
  return modelId
    .replace(/[:/]/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-{2,}/g, "-");
}

function buildModelMap(models) {
  const map = new Map();

  for (const model of models) {
    const modelId = typeof model.id === "string" ? model.id.trim() : "";
    if (!modelId) continue;

    const baseModelKey = toModelKey(modelId);
    let modelKey = baseModelKey;
    let suffix = 2;

    // Distinct upstream models must never collapse onto the same key (e.g.
    // "qwen3.8-27b" vs "qwen3.8-2.4t-a95b" both strip to "qwen3.8"). When a
    // collision occurs, fall back to the full normalized id so the model stays
    // addressable instead of being merged as a wrong alias.
    while (map.has(modelKey) && map.get(modelKey) !== modelId) {
      modelKey = suffix === 2 ? fullModelKey(modelId) : `${fullModelKey(modelId)}-${suffix}`;
      suffix += 1;
    }

    map.set(modelKey, modelId);
  }

  return new Map([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function buildMetadataLookup(models) {
  const lookup = new Map();
  for (const model of models) {
    if (typeof model.id === "string" && model.id.trim()) {
      lookup.set(model.id.trim(), model);
    }
  }
  return lookup;
}

function enrichNewModels(modelsDir, addedKeys, modelMap, metadataLookup) {
  const index = buildModelIndex(modelsDir);

  for (const modelKey of addedKeys) {
    const entry = Object.values(index).find((item) => item.fileId === modelKey || item.id === modelKey);
    if (!entry) continue;

    const upstreamName = modelMap.get(modelKey);
    const model = upstreamName ? metadataLookup.get(upstreamName) : null;
    if (!model) continue;

    const data = entry.data;
    if (!data.meta) data.meta = {};

    const hasReasoning =
      Array.isArray(model.reasoning?.effort_levels) &&
      model.reasoning.effort_levels.length > 0;
    if (hasReasoning) data.meta.reasoning = true;

    data.meta.toolCall = true;
    data.meta.vision = model.capabilities?.vision === true;

    writeModelJson(entry.path, data);
  }
}

async function fetchHyperModels() {
  const payload = await fetchJson(HYPER_MODELS_URL, {
    label: "Hyper /v1/models",
  });
  if (!payload || !Array.isArray(payload.data)) {
    throw new Error("Unexpected Hyper /v1/models payload format");
  }

  const models = payload.data.filter(
    (model) => typeof model.id === "string" && model.id.trim().length > 0
  );
  if (models.length < MIN_EXPECTED_MODELS) {
    throw new Error(`Hyper /v1/models returned only ${models.length} models (expected >= ${MIN_EXPECTED_MODELS})`);
  }

  return models;
}

async function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const modelsDir = resolve(scriptDir, "../models");

  const models = await fetchHyperModels();
  const modelMap = buildModelMap(models);
  const metadataLookup = buildMetadataLookup(models);

  const result = syncProviderModels(modelsDir, PROVIDER_NAME, modelMap);

  if (result.added.length > 0) {
    enrichNewModels(modelsDir, result.added, modelMap, metadataLookup);
  }

  if (result.added.length === 0 && result.removed.length === 0 && result.updated.length === 0) {
    console.log(`Hyper models are already up to date (${modelMap.size} models).`);
  } else {
    console.log(`Hyper: ${modelMap.size} models (added ${result.added.length}, removed ${result.removed.length}, updated ${result.updated.length}).`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});