#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const FETCH_TIMEOUT_MS = 20_000;
const MAX_FETCH_ATTEMPTS = 3;
const MODEL_MAP_EXPORT_PATTERN =
  /export const OPENROUTER_MODEL_MAP: Record<string, string> = \{[\s\S]*?\n\};/;

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

  if (modelKey !== "openrouter-free" && modelKey.endsWith("-free")) {
    return modelKey.slice(0, -"-free".length);
  }

  return modelKey;
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : Number.NaN;
}

function isFreeChatModel(model) {
  if (!model || typeof model !== "object") {
    return false;
  }

  const id = typeof model.id === "string" ? model.id.trim() : "";
  if (!id) {
    return false;
  }

  const pricing = model.pricing || {};
  const promptPrice = toNumber(pricing.prompt);
  const completionPrice = toNumber(pricing.completion);
  if (promptPrice !== 0 || completionPrice !== 0) {
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

function renderModelMap(modelMap) {
  const lines = [...modelMap.entries()].map(
    ([modelKey, upstreamModel]) =>
      `  ${JSON.stringify(modelKey)}: ${JSON.stringify(upstreamModel)},`
  );

  return [
    "export const OPENROUTER_MODEL_MAP: Record<string, string> = {",
    ...lines,
    "};",
  ].join("\n");
}

function sleep(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

async function fetchOpenRouterFreeModelIds() {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(OPENROUTER_MODELS_URL, {
        headers: {
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(
          `Failed to fetch models (${response.status} ${response.statusText})`
        );
      }

      const payload = await response.json();
      if (!payload || !Array.isArray(payload.data)) {
        throw new Error("Unexpected OpenRouter /v1/models payload format");
      }

      const ids = payload.data
        .filter((item) => isFreeChatModel(item))
        .map((item) => item.id.trim())
        .filter((id) => id.length > 0);

      return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
    } catch (error) {
      lastError = error;

      if (attempt < MAX_FETCH_ATTEMPTS) {
        await sleep(attempt * 1_000);
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Failed to fetch OpenRouter free model list");
}

async function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const constantsPath = resolve(
    scriptDir,
    "../lib/proxy/providers/openrouter/constants.ts"
  );

  const modelIds = await fetchOpenRouterFreeModelIds();
  const modelMap = buildModelMap(modelIds);
  const nextExportBlock = renderModelMap(modelMap);

  const currentFile = readFileSync(constantsPath, "utf8");
  if (!MODEL_MAP_EXPORT_PATTERN.test(currentFile)) {
    throw new Error("Could not locate OPENROUTER_MODEL_MAP export block");
  }

  const nextFile = currentFile.replace(MODEL_MAP_EXPORT_PATTERN, nextExportBlock);

  if (nextFile === currentFile) {
    console.log(`OpenRouter free model map is already up to date (${modelMap.size} keys).`);
    return;
  }

  writeFileSync(constantsPath, nextFile);
  console.log(`Updated OpenRouter free model map with ${modelMap.size} keys.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
