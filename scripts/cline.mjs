#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildModelIdMap, syncProviderModels } from "./model-registry.mjs";
import { fetchJson } from "./lib/shared.mjs";
import { stripParamInfoKey } from "./lib/clean-key.mjs";

const PROVIDER_NAME = "cline";
// Cline exposes its curated free model list on the recommended-models
// endpoint (the same source the Cline CLI/VSCode use to zero-cost free
// models). Only entries under `free` are usable without ClinePass credits.
const CLINE_RECOMMENDED_MODELS_URL =
  "https://api.cline.bot/api/v1/ai/cline/recommended-models";

// Minimum number of free models expected; guards against silent breakage of
// the recommended-models payload format.
const MIN_EXPECTED_MODELS = 1;

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
  return buildModelIdMap(modelIds, toModelKey);
}

async function fetchClineFreeModelIds() {
  const data = await fetchJson(CLINE_RECOMMENDED_MODELS_URL, {
    label: "Cline recommended models",
  });
  if (!data || !Array.isArray(data.free)) {
    throw new Error("Unexpected Cline recommended-models payload format");
  }

  const ids = data.free
    .map((model) => (model && typeof model === "object" ? model.id : undefined))
    .filter((id) => typeof id === "string" && id.trim().length > 0)
    .map((id) => id.trim());

  if (ids.length < MIN_EXPECTED_MODELS) {
    throw new Error(`Expected at least ${MIN_EXPECTED_MODELS} Cline free model(s), got ${ids.length}`);
  }

  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

async function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const modelsDir = resolve(scriptDir, "../models");

  const modelIds = await fetchClineFreeModelIds();
  const modelMap = buildModelMap(modelIds);

  const result = syncProviderModels(modelsDir, PROVIDER_NAME, modelMap);

  if (result.added.length === 0 && result.removed.length === 0 && result.updated.length === 0) {
    console.log(`Cline free models are already up to date (${modelMap.size} models).`);
  } else {
    console.log(`Cline: ${modelMap.size} free models (added ${result.added.length}, removed ${result.removed.length}, updated ${result.updated.length}).`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
