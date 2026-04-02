#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { syncProviderToToml } from "./toml-utils.mjs";

const KILO_CODE_MODELS_URL = "https://api.kilo.ai/api/gateway/models";
const FETCH_TIMEOUT_MS = 20_000;
const MAX_FETCH_ATTEMPTS = 3;

const MODEL_KEY_OVERRIDES = new Map([
  ["x-ai/grok-code-fast-1:optimized:free", "grok-code-fast-1"],
]);

function toModelKey(modelId) {
  const override = MODEL_KEY_OVERRIDES.get(modelId);
  if (override) return override;

  // kilo-auto/* models: replace / with -
  if (modelId.startsWith("kilo-auto/")) {
    return modelId.replace("/", "-");
  }

  // Strip provider prefix (e.g. "minimax/minimax-m2.5:free" → "minimax-m2.5:free")
  const withoutProvider = modelId.includes("/")
    ? modelId.slice(modelId.indexOf("/") + 1)
    : modelId;

  // Remove :free suffix for the key (but keep full ID as upstream)
  const modelKey = withoutProvider
    .replace(/:free$/, "")
    .replace(/[:/]/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-{2,}/g, "-");

  return modelKey;
}

function isEligibleModel(model) {
  if (!model || typeof model !== "object") return false;

  const id = typeof model.id === "string" ? model.id.trim() : "";
  if (!id) return false;

  // Include all kilo-auto models (smart routing)
  if (id.startsWith("kilo-auto/")) return true;

  // Include all free models
  if (model.isFree === true) return true;

  return false;
}

function buildModelMap(models) {
  const map = new Map();

  for (const model of models) {
    const modelId = model.id.trim();
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

function sleep(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

async function fetchKiloCodeModels() {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(KILO_CODE_MODELS_URL, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(
          `Failed to fetch models (${response.status} ${response.statusText})`
        );
      }

      const payload = await response.json();
      if (!payload || !Array.isArray(payload.data)) {
        throw new Error("Unexpected Kilo Gateway /models payload format");
      }

      return payload.data.filter((item) => isEligibleModel(item));
    } catch (error) {
      lastError = error;

      if (attempt < MAX_FETCH_ATTEMPTS) {
        await sleep(attempt * 1_000);
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Failed to fetch Kilo Code model list");
}

async function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const modelsDir = resolve(scriptDir, "../packages/shared/models");

  const models = await fetchKiloCodeModels();
  const modelMap = buildModelMap(models);

  const result = syncProviderToToml(modelsDir, "kilo_code", modelMap);

  if (result.added.length === 0 && result.removed.length === 0 && result.updated.length === 0) {
    console.log(`Kilo Code models are already up to date (${modelMap.size} models).`);
  } else {
    console.log(`Kilo Code: ${modelMap.size} models (added ${result.added.length}, removed ${result.removed.length}, updated ${result.updated.length}).`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
