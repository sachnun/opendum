#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { syncProviderToToml } from "./toml-utils.mjs";

const NVIDIA_MODELS_URL = "https://integrate.api.nvidia.com/v1/models";
const FETCH_TIMEOUT_MS = 20_000;
const MAX_FETCH_ATTEMPTS = 3;

const MODEL_KEY_OVERRIDES = {
  "baichuan-inc/baichuan2-13b-chat": "baichuan2-13b-chat",
  "nvidia/nvidia-nemotron-nano-9b-v2": "nemotron-nano-9b-v2",
  "qwen/qwen2.5-coder-32b-instruct": "qwen2.5-coder-32b",
  "qwen/qwen2.5-coder-7b-instruct": "qwen2.5-coder-7b",
};

const NON_CHAT_MODEL_TOKENS = [
  "embed",
  "retriever",
  "rerank",
  "parse",
  "guard",
  "safety",
  "reward",
  "clip",
  "translate",
  "deplot",
  "paligemma",
  "kosmos",
  "streampetr",
  "vila",
];

const CHAT_MODEL_PATTERNS = [
  /(^|[\/-])(chat|instruct)([\/-]|$)/i,
  /thinking/i,
  /gpt-oss/i,
  /-it($|[\/-])/i,
  /deepseek-ai\/deepseek-v3\./i,
  /minimaxai\/minimax-m2/i,
  /moonshotai\/kimi-k2/i,
  /z-ai\/glm/i,
  /qwen\/qwq-/i,
  /qwen\/qwen3-235b-a22b/i,
  /mistralai\/mistral-large($|[-\/])/i,
  /mistralai\/mistral-medium($|[-\/])/i,
  /mistralai\/mistral-small($|[-\/])/i,
  /mistralai\/magistral-small($|[-\/])/i,
  /mistralai\/mistral-nemotron($|[-\/])/i,
  /nvidia\/cosmos-reason/i,
];

function sleep(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function toModelKey(modelId) {
  const normalizedModelId = modelId.replace(/^library\//, "");
  const overriddenKey = MODEL_KEY_OVERRIDES[normalizedModelId];
  if (overriddenKey) {
    return overriddenKey;
  }

  const slashIndex = normalizedModelId.indexOf("/");
  const baseModelId = slashIndex === -1
    ? normalizedModelId
    : normalizedModelId.slice(slashIndex + 1);

  return baseModelId
    .replace(/[:/]/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-{2,}/g, "-");
}

function isNonChatModel(modelId) {
  const normalized = modelId.toLowerCase();
  return NON_CHAT_MODEL_TOKENS.some((token) => normalized.includes(token));
}

function isLikelyChatModel(modelId) {
  if (isNonChatModel(modelId)) {
    return false;
  }

  return CHAT_MODEL_PATTERNS.some((pattern) => pattern.test(modelId));
}

function buildModelMap(modelIds, existingKeys) {
  const allAvailableModels = [...new Set(modelIds)].sort((a, b) => a.localeCompare(b));
  const availableChatCandidateSet = new Set(
    allAvailableModels.filter((modelId) => !isNonChatModel(modelId))
  );
  const likelyChatSet = new Set(
    allAvailableModels.filter((modelId) => isLikelyChatModel(modelId))
  );

  const nextMap = new Map();

  // Retain existing models that are still available
  for (const [modelKey, upstreamModel] of existingKeys.entries()) {
    if (!availableChatCandidateSet.has(upstreamModel)) {
      continue;
    }

    nextMap.set(modelKey, upstreamModel);
  }

  const mappedValues = new Set(nextMap.values());

  // Add new chat models
  for (const upstreamModel of allAvailableModels) {
    if (mappedValues.has(upstreamModel)) {
      continue;
    }

    if (!likelyChatSet.has(upstreamModel)) {
      continue;
    }

    const baseModelKey = toModelKey(upstreamModel);
    let modelKey = baseModelKey;
    let suffix = 2;

    while (nextMap.has(modelKey) && nextMap.get(modelKey) !== upstreamModel) {
      modelKey = `${baseModelKey}-${suffix}`;
      suffix += 1;
    }

    nextMap.set(modelKey, upstreamModel);
    mappedValues.add(upstreamModel);
  }

  return new Map([...nextMap.entries()].sort(([a], [b]) => a.localeCompare(b)));
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

async function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const modelsDir = resolve(scriptDir, "../packages/shared/models");

  // Build existing model map from TOML files to preserve existing keys
  const { buildTomlIndex } = await import("./toml-utils.mjs");
  const index = buildTomlIndex(modelsDir);
  const existingKeys = new Map();
  for (const [modelId, entry] of Object.entries(index)) {
    const providers = entry.data.opendum?.providers || [];
    if (providers.includes("nvidia_nim")) {
      const upstream = entry.data.opendum?.upstream?.nvidia_nim || modelId;
      existingKeys.set(modelId, upstream);
    }
  }

  const modelIds = await fetchNvidiaModelIds();
  const nextMap = buildModelMap(modelIds, existingKeys);

  const result = syncProviderToToml(modelsDir, "nvidia_nim", nextMap);

  if (result.added.length === 0 && result.removed.length === 0 && result.updated.length === 0) {
    console.log(`Nvidia NIM models are already up to date (${nextMap.size} models).`);
  } else {
    console.log(`Nvidia NIM: ${nextMap.size} models (added ${result.added.length}, removed ${result.removed.length}, updated ${result.updated.length}).`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
