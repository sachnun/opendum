#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { syncProviderModels } from "./model-registry.mjs";

const OPENCODE_MODELS_URL = "https://unroxy.koyeb.app/opencode.ai/zen/v1/models";
const FETCH_TIMEOUT_MS = 20_000;
const MAX_FETCH_ATTEMPTS = 3;

const MODEL_KEY_OVERRIDES = new Map([
  ["deepseek-v4-flash-free", "deepseek-v4-flash"],
  ["minimax-m2.5-free", "minimax-m2.5"],
  ["ring-2.6-1t-free", "ring-2.6-1t"],
  ["trinity-large-preview-free", "trinity-large-preview"],
  ["nemotron-3-super-free", "nemotron-3-super"],
]);

function sleep(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function toModelKey(modelId) {
  const override = MODEL_KEY_OVERRIDES.get(modelId);
  if (override) return override;
  if (modelId.endsWith("-free")) return modelId.slice(0, -"-free".length);
  return modelId;
}

function isFreeModelId(modelId) {
  return modelId === "big-pickle" || modelId.endsWith("-free");
}

async function fetchOpencodeFreeModelIds() {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(OPENCODE_MODELS_URL, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch Opencode models (${response.status} ${response.statusText})`);
      }

      const payload = await response.json();
      if (!payload || !Array.isArray(payload.data)) {
        throw new Error("Unexpected Opencode /zen/v1/models payload format");
      }

      return payload.data
        .map((model) => typeof model?.id === "string" ? model.id.trim() : "")
        .filter((id) => id && isFreeModelId(id))
        .sort((a, b) => a.localeCompare(b));
    } catch (error) {
      lastError = error;
      if (attempt < MAX_FETCH_ATTEMPTS) await sleep(attempt * 1_000);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Failed to fetch Opencode model list");
}

function buildModelMap(modelIds) {
  const map = new Map();

  for (const modelId of modelIds) {
    const modelKey = toModelKey(modelId);
    if (!map.has(modelKey)) {
      map.set(modelKey, modelId);
    }
  }

  return new Map([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

async function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const modelsDir = resolve(scriptDir, "../models");

  const modelIds = await fetchOpencodeFreeModelIds();
  const modelMap = buildModelMap(modelIds);
  const result = syncProviderModels(modelsDir, "opencode", modelMap);

  if (result.added.length === 0 && result.removed.length === 0 && result.updated.length === 0) {
    console.log(`Opencode free models are already up to date (${modelMap.size} models).`);
  } else {
    console.log(`Opencode: ${modelMap.size} free models (added ${result.added.length}, removed ${result.removed.length}, updated ${result.updated.length}).`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
