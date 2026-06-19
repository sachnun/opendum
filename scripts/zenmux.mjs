#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { syncProviderModels } from "./model-registry.mjs";
import { fetchJson } from "./lib/shared.mjs";

const PROVIDER_NAME = "zenmux";
const ZENMUX_MODELS_URL = "https://zenmux.ai/api/v1/models";

function toModelKey(modelId) {
  const slashIndex = modelId.indexOf("/");
  const baseModelId = slashIndex === -1 ? modelId : modelId.slice(slashIndex + 1);

  const modelKey = baseModelId
    .replace(/[:/]/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-{2,}/g, "-");

  return modelKey.endsWith("-free") ? modelKey.slice(0, -"-free".length) : modelKey;
}

function isZeroPriced(model) {
  const pricings = model && typeof model.pricings === "object" ? model.pricings : null;
  if (!pricings) {
    return false;
  }
  const amounts = [];
  for (const entries of Object.values(pricings)) {
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries) {
      if (entry && typeof entry.value === "number") {
        amounts.push(entry.value);
      }
    }
  }
  return amounts.length > 0 && amounts.every((value) => value === 0);
}

function isFreeChatModel(model) {
  if (!model || typeof model !== "object") {
    return false;
  }

  const id = typeof model.id === "string" ? model.id.trim() : "";
  if (!id || !id.endsWith("-free")) {
    return false;
  }

  const outputModalities = Array.isArray(model.output_modalities) ? model.output_modalities : [];
  const supportsTextOutput = outputModalities.length === 0 || outputModalities.includes("text");
  if (!supportsTextOutput) {
    return false;
  }

  return isZeroPriced(model);
}

function buildModelMap(modelIds) {
  const map = new Map();

  for (const modelId of modelIds) {
    const baseModelKey = toModelKey(modelId);
    let modelKey = baseModelKey;
    let suffix = 2;

    while (map.has(modelKey) && map.get(modelKey) !== modelId) {
      modelKey = `${baseModelKey}-${suffix}`;
      suffix += 1;
    }

    map.set(modelKey, modelId);
  }

  return new Map([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

async function fetchZenmuxFreeModelIds() {
  const payload = await fetchJson(ZENMUX_MODELS_URL, { label: "ZenMux /v1/models" });
  if (!payload || !Array.isArray(payload.data)) {
    throw new Error("Unexpected ZenMux /v1/models payload format");
  }

  const ids = payload.data
    .filter((item) => isFreeChatModel(item))
    .map((item) => item.id.trim())
    .filter((id) => id.length > 0);

  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

async function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const modelsDir = resolve(scriptDir, "../models");

  const modelIds = await fetchZenmuxFreeModelIds();
  const modelMap = buildModelMap(modelIds);

  const result = syncProviderModels(modelsDir, PROVIDER_NAME, modelMap);

  if (result.added.length === 0 && result.removed.length === 0 && result.updated.length === 0) {
    console.log(`ZenMux free models are already up to date (${modelMap.size} models).`);
  } else {
    console.log(`ZenMux: ${modelMap.size} models (added ${result.added.length}, removed ${result.removed.length}, updated ${result.updated.length}).`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
