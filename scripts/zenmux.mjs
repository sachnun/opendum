#!/usr/bin/env bun

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { syncProviderModels } from "./model-registry.mjs";
import { fetchJson } from "./lib/shared.mjs";
import { stripParamInfoKey } from "./lib/clean-key.mjs";

const PROVIDER_NAME = "zenmux";
const ZENMUX_PLANS_URL = "https://zenmux.ai/api/subscription/public/get_all_plans";
const ZENMUX_MODELS_URL = "https://zenmux.ai/api/v1/models";

function toModelKey(modelId) {
  const slashIndex = modelId.indexOf("/");
  const baseModelId = slashIndex === -1 ? modelId : modelId.slice(slashIndex + 1);

  const modelKey = baseModelId
    .replace(/[:/]/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-{2,}/g, "-");

  const cleaned = stripParamInfoKey(modelKey);
  return cleaned.endsWith("-free") ? cleaned.slice(0, -"-free".length) : cleaned;
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

async function fetchZenmuxFreePlanModelIds() {
  const plans = await fetchJson(ZENMUX_PLANS_URL, { label: "ZenMux subscription plans" });
  if (!plans || !Array.isArray(plans.data)) {
    throw new Error("Unexpected ZenMux get_all_plans payload format");
  }

  const freePlan = plans.data.find(
    (p) => p.desc?.includes("5 Flows/5h"),
  );
  if (!freePlan || !Array.isArray(freePlan.models)) {
    throw new Error("Free Plan (5 Flows/5h) not found in ZenMux plans");
  }

  const planSlugs = new Set(
    freePlan.models
      .filter((m) => m.provider_slug === "*")
      .map((m) => m.model_slug),
  );

  if (planSlugs.size === 0) {
    throw new Error("No models found in ZenMux Free Plan");
  }

  const allModels = await fetchJson(ZENMUX_MODELS_URL, { label: "ZenMux /v1/models" });
  if (!allModels || !Array.isArray(allModels.data)) {
    throw new Error("Unexpected ZenMux /v1/models payload format");
  }

  const ids = allModels.data
    .filter((m) => planSlugs.has(m.id))
    .filter((m) => {
      const outputModalities = Array.isArray(m.output_modalities) ? m.output_modalities : [];
      return outputModalities.length === 0 || outputModalities.includes("text");
    })
    .map((m) => m.id.trim())
    .filter((id) => id.length > 0);

  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

async function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const modelsDir = resolve(scriptDir, "../models");

  const modelIds = await fetchZenmuxFreePlanModelIds();
  const modelMap = buildModelMap(modelIds);

  const result = syncProviderModels(modelsDir, PROVIDER_NAME, modelMap, {
    providerConfigByModel: new Map(
      modelIds.map((id) => [toModelKey(id), {}]),
    ),
  });

  if (result.added.length === 0 && result.removed.length === 0 && result.updated.length === 0) {
    console.log(`ZenMux free plan models are already up to date (${modelMap.size} models).`);
  } else {
    console.log(`ZenMux: ${modelMap.size} models (added ${result.added.length}, removed ${result.removed.length}, updated ${result.updated.length}).`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
