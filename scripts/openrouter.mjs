#!/usr/bin/env node

import { syncProviderModels } from "./model-registry.mjs";
import { fetchJson, parseFlags, resolveModelsDir, logSyncResult, uniqueModelKey } from "./lib/shared.mjs";
import { stripParamInfoKey } from "./lib/clean-key.mjs";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

const IGNORED_MODEL_KEYS = new Set(["gpt-oss-120b"]);

function toModelKey(modelId) {
  const normalizedModelId = modelId.replace(/^library\//, "");
  const providerStrippedModelId =
    normalizedModelId === "openrouter/free"
      ? normalizedModelId
      : normalizedModelId.includes("/")
        ? normalizedModelId.slice(normalizedModelId.indexOf("/") + 1)
        : normalizedModelId;

  const modelKey = providerStrippedModelId
    .replace(/[:/]/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-{2,}/g, "-");

  const cleaned = stripParamInfoKey(modelKey);
  if (modelKey !== "openrouter-free" && cleaned.endsWith("-free")) {
    return cleaned.slice(0, -"-free".length);
  }

  return cleaned;
}

function isFreeChatModel(model) {
  if (!model || typeof model !== "object") {
    return false;
  }

  const id = typeof model.id === "string" ? model.id.trim() : "";
  if (!id) {
    return false;
  }

  const isFreeModelId = id === "openrouter/free" || id.endsWith(":free");
  if (!isFreeModelId) {
    return false;
  }

  const inputModalities = Array.isArray(model.architecture?.input_modalities)
    ? model.architecture.input_modalities
    : [];
  const outputModalities = Array.isArray(model.architecture?.output_modalities)
    ? model.architecture.output_modalities
    : [];
  const supportsTextInput =
    inputModalities.length === 0 || inputModalities.includes("text");
  const supportsTextOutput =
    outputModalities.length === 0 || outputModalities.includes("text");
  if (!supportsTextInput || !supportsTextOutput) {
    return false;
  }

  const supportedParameters = Array.isArray(model.supported_parameters)
    ? model.supported_parameters
    : [];
  const supportsChatLikeParams =
    supportedParameters.length === 0 ||
    supportedParameters.includes("max_tokens") ||
    supportedParameters.includes("temperature") ||
    supportedParameters.includes("tools");

  return supportsChatLikeParams;
}

function buildModelMap(modelIds) {
  const map = new Map();

  for (const modelId of modelIds) {
    const baseModelKey = toModelKey(modelId);
    if (IGNORED_MODEL_KEYS.has(baseModelKey)) {
      continue;
    }
    const modelKey = uniqueModelKey(map, baseModelKey, modelId);
    map.set(modelKey, modelId);
  }

  return new Map([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

async function fetchOpenRouterFreeModelIds() {
  const payload = await fetchJson(OPENROUTER_MODELS_URL, { label: "OpenRouter /v1/models" });
  if (!payload || !Array.isArray(payload.data)) {
    throw new Error("Unexpected OpenRouter /v1/models payload format");
  }

  const ids = payload.data
    .filter((item) => isFreeChatModel(item))
    .map((item) => item.id.trim())
    .filter((id) => id.length > 0);

  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

async function main() {
  const { dryRun } = parseFlags();
  const modelsDir = resolveModelsDir(import.meta.url);

  const modelIds = await fetchOpenRouterFreeModelIds();
  const modelMap = buildModelMap(modelIds);

  const result = syncProviderModels(modelsDir, "openrouter", modelMap, { dryRun });

  logSyncResult({ label: "[openrouter] free", count: modelMap.size, result, would: dryRun });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
