#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { syncProviderToToml } from "./toml-utils.mjs";

const OLLAMA_MODELS_URL = "https://ollama.com/v1/models";
const FETCH_TIMEOUT_MS = 20_000;
const MAX_FETCH_ATTEMPTS = 3;

const FORCED_MODEL_KEYS = {
  "gpt-oss-120b-medium": "gpt-oss:120b",
  "kimi-k2": "kimi-k2:1t",
};

function toModelKey(modelId) {
  return modelId
    .replace(/^library\//, "")
    .replace(/[:/]/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-{2,}/g, "-");
}

function buildModelMap(modelIds) {
  const map = new Map();

  for (const modelId of modelIds) {
    map.set(toModelKey(modelId), modelId);
  }

  for (const [modelKey, upstreamModel] of Object.entries(FORCED_MODEL_KEYS)) {
    if (modelIds.includes(upstreamModel)) {
      map.set(modelKey, upstreamModel);
    }
  }

  return new Map([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function sleep(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

async function fetchOllamaCloudModelIds() {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(OLLAMA_MODELS_URL, {
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
        throw new Error("Unexpected Ollama /v1/models payload format");
      }

      const ids = payload.data
        .map((item) => (typeof item?.id === "string" ? item.id.trim() : ""))
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
    : new Error("Failed to fetch Ollama Cloud model list");
}

async function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const modelsDir = resolve(scriptDir, "../models");

  const modelIds = await fetchOllamaCloudModelIds();
  const modelMap = buildModelMap(modelIds);

  const result = syncProviderToToml(modelsDir, "ollama_cloud", modelMap);

  if (result.added.length === 0 && result.removed.length === 0 && result.updated.length === 0) {
    console.log(`Ollama Cloud models are already up to date (${modelMap.size} models).`);
  } else {
    console.log(`Ollama Cloud: ${modelMap.size} models (added ${result.added.length}, removed ${result.removed.length}, updated ${result.updated.length}).`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
