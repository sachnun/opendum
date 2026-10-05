#!/usr/bin/env node

import { isDirectRun, runSourceCli } from "./cli.ts";
import type { ModelSource } from "./source.ts";

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildModelIndex, syncProviderModels, getProviderUpstream } from "#models/registry/registry.ts";
import { sleep, MAX_FETCH_ATTEMPTS, FETCH_TIMEOUT_MS } from "#models/lib/http.ts";
import { buildModelMap, extractNvidiaGenerativeModelKeys } from "./lib/nvidia-parse.ts";

const PROVIDER_NAME = "nvidia_nim";
const NVIDIA_MODELS_URL = "https://integrate.api.nvidia.com/v1/models";
const NVIDIA_MODEL_DOCS_URLS = [
  "https://docs.api.nvidia.com/nim/reference/llm-apis",
  "https://docs.api.nvidia.com/nim/reference/multimodal-apis",
  "https://docs.api.nvidia.com/nim/reference/visual-models-apis",
];

async function fetchNvidiaGenerativeModelKeys() {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt += 1) {
    try {
      const pages = await Promise.all(
        NVIDIA_MODEL_DOCS_URLS.map(async (url) => {
          const response = await fetch(url, {
            headers: {
              Accept: "text/html",
            },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          });

          if (!response.ok) {
            throw new Error(
              `Failed to fetch Nvidia model docs (${response.status} ${response.statusText})`
            );
          }

          return response.text();
        })
      );
      const modelKeys = new Set(
        pages.flatMap((page) => [...extractNvidiaGenerativeModelKeys(page)])
      );
      if (modelKeys.size === 0) {
        throw new Error("Unexpected Nvidia model docs payload format");
      }

      return modelKeys;
    } catch (error) {
      lastError = error;

      if (attempt < MAX_FETCH_ATTEMPTS) {
        await sleep(attempt * 1_000);
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Failed to fetch Nvidia generative model list");
}

async function fetchNvidiaModelIds() {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(NVIDIA_MODELS_URL, {
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
        throw new Error("Unexpected Nvidia /v1/models payload format");
      }

      return payload.data
        .map((item) => (typeof item?.id === "string" ? item.id.trim() : ""))
        .filter((id) => id.length > 0);
    } catch (error) {
      lastError = error;

      if (attempt < MAX_FETCH_ATTEMPTS) {
        await sleep(attempt * 1_000);
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Failed to fetch Nvidia NIM model list");
}

async function run() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const modelsDir = resolve(scriptDir, "../data");

  const index = buildModelIndex(modelsDir);
  const existingKeys = new Map();
  for (const [modelId, entry] of Object.entries(index)) {
    const providers = entry.data.providers || [];
    if (providers.includes(PROVIDER_NAME)) {
      const upstream = getProviderUpstream(entry.data, PROVIDER_NAME, modelId);
      existingKeys.set(entry.id || modelId, upstream);
    }
  }

  const [modelIds, llmModelKeys] = await Promise.all([
    fetchNvidiaModelIds(),
    fetchNvidiaGenerativeModelKeys(),
  ]);
  const nextMap = buildModelMap(modelIds, existingKeys, llmModelKeys);

  const result = syncProviderModels(modelsDir, PROVIDER_NAME, nextMap);

  if (result.added.length === 0 && result.removed.length === 0 && result.updated.length === 0) {
    console.log(`Nvidia NIM models are already up to date (${nextMap.size} models).`);
  } else {
    console.log(`Nvidia NIM: ${nextMap.size} models (added ${result.added.length}, removed ${result.removed.length}, updated ${result.updated.length}).`);
  }
}


export const source: ModelSource = { name: "nvidia", run };

if (isDirectRun(import.meta.url)) runSourceCli(source);
