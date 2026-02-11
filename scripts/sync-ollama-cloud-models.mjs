#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OLLAMA_MODELS_URL = "https://ollama.com/v1/models";
const FETCH_TIMEOUT_MS = 20_000;
const MAX_FETCH_ATTEMPTS = 3;
const MODEL_MAP_EXPORT_PATTERN =
  /export const OLLAMA_CLOUD_MODEL_MAP: Record<string, string> = \{[\s\S]*?\n\};/;

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

function renderModelMap(modelMap) {
  const lines = [...modelMap.entries()].map(
    ([modelKey, upstreamModel]) =>
      `  ${JSON.stringify(modelKey)}: ${JSON.stringify(upstreamModel)},`
  );

  return [
    "export const OLLAMA_CLOUD_MODEL_MAP: Record<string, string> = {",
    ...lines,
    "};",
  ].join("\n");
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
          "User-Agent": "opendum-sync-ollama-cloud-models",
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
  const checkOnly = process.argv.includes("--check");

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const constantsPath = resolve(
    scriptDir,
    "../lib/proxy/providers/ollama-cloud/constants.ts"
  );

  const modelIds = await fetchOllamaCloudModelIds();
  const modelMap = buildModelMap(modelIds);
  const nextExportBlock = renderModelMap(modelMap);

  const currentFile = readFileSync(constantsPath, "utf8");
  if (!MODEL_MAP_EXPORT_PATTERN.test(currentFile)) {
    throw new Error("Could not locate OLLAMA_CLOUD_MODEL_MAP export block");
  }

  const nextFile = currentFile.replace(MODEL_MAP_EXPORT_PATTERN, nextExportBlock);

  if (nextFile === currentFile) {
    console.log(`Ollama Cloud model map is already up to date (${modelMap.size} keys).`);
    return;
  }

  if (checkOnly) {
    console.error("Ollama Cloud model map is out of date. Run: npm run sync:ollama-cloud");
    process.exitCode = 1;
    return;
  }

  writeFileSync(constantsPath, nextFile);
  console.log(`Updated Ollama Cloud model map with ${modelMap.size} keys.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
