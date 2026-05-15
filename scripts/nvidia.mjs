#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildModelIndex, syncProviderModels, getProviderUpstream } from "./model-registry.mjs";

const PROVIDER_NAME = "nvidia_nim";
const NVIDIA_MODELS_URL = "https://integrate.api.nvidia.com/v1/models";
const NVIDIA_MODEL_DOCS_URLS = [
  "https://docs.api.nvidia.com/nim/reference/llm-apis",
  "https://docs.api.nvidia.com/nim/reference/multimodal-apis",
  "https://docs.api.nvidia.com/nim/reference/visual-models-apis",
];
const FETCH_TIMEOUT_MS = 20_000;
const MAX_FETCH_ATTEMPTS = 3;

const MODEL_KEY_OVERRIDES = {
  "baichuan-inc/baichuan2-13b-chat": "baichuan2-13b-chat",
  "nvidia/nvidia-nemotron-nano-9b-v2": "nemotron-nano-9b-v2",
  "qwen/qwen2.5-coder-32b-instruct": "qwen2.5-coder-32b",
  "qwen/qwen2.5-coder-7b-instruct": "qwen2.5-coder-7b",
};

const EXCLUDED_MODEL_KEY_TOKENS = [
  "detection",
  "embed",
  "embedding",
  "guard",
  "nemoretriever",
  "parse",
  "rerank",
  "retriever",
  "safety",
  "vila",
];

const IGNORED_MODEL_KEYS = new Set(["gpt-oss-120b", "mistral-large"]);

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

function normalizeModelIdForMatch(modelId) {
  return modelId
    .replace(/^library\//, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripHtml(value) {
  return decodeHtmlEntities(value.replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

function isChatCompletionEndpoint(description) {
  const normalized = description.toLowerCase();
  const nonChatMarkers = [
    "embedding",
    "classification",
    "classify",
    "detection",
    "generate dna",
    "generation",
    "ranking",
    "rerank",
    "retrieval",
    "search post",
    "status polling",
  ];

  if (nonChatMarkers.some((marker) => normalized.includes(marker))) {
    return false;
  }

  return normalized.includes("chat conversation") ||
    normalized.includes("chat completion") ||
    normalized.includes("create completion") ||
    normalized.includes("request response from the model");
}

function isExcludedModelKey(modelId) {
  const normalized = normalizeModelIdForMatch(modelId);
  return EXCLUDED_MODEL_KEY_TOKENS.some((token) => normalized.includes(token));
}

function extractNvidiaGenerativeModelKeys(html) {
  const articleStart = html.indexOf('data-testid="RDMD"');
  const articleEnd = articleStart === -1 ? -1 : html.indexOf("</article>", articleStart);
  const article = articleStart === -1
    ? html
    : html.slice(articleStart, articleEnd === -1 ? undefined : articleEnd);
  const modelKeys = new Set();
  const rowPattern = /<tr>([\s\S]*?)<\/tr>/g;
  let rowMatch;

  while ((rowMatch = rowPattern.exec(article)) !== null) {
    const cells = [...rowMatch[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(
      (match) => match[1]
    );

    if (cells.length < 2) {
      continue;
    }

    const modelMatch = cells[0].match(/<a\b[^>]*>([\s\S]*?)<\/a>/);
    const endpointMatch = cells[1].match(/<a\b[^>]*>([\s\S]*?)<\/a>/);
    if (!modelMatch || !endpointMatch) {
      continue;
    }

    const modelId = stripHtml(modelMatch[1]).replace(/\s*\/\s*/, "/");
    const endpoint = stripHtml(endpointMatch[1]);
    if (
      modelId.includes("/") &&
      !isExcludedModelKey(modelId) &&
      isChatCompletionEndpoint(endpoint)
    ) {
      modelKeys.add(normalizeModelIdForMatch(modelId));
    }
  }

  return modelKeys;
}

function buildModelMap(modelIds, existingKeys, llmModelKeys) {
  const allAvailableModels = [...new Set(modelIds)].sort((a, b) => a.localeCompare(b));
  const availableModelSet = new Set(allAvailableModels);
  const availableModelByKey = new Map();
  for (const modelId of allAvailableModels) {
    const modelKey = toModelKey(modelId);
    if (!availableModelByKey.has(modelKey)) {
      availableModelByKey.set(modelKey, modelId);
    }
  }

  const availableLlmModelSet = new Set(
    allAvailableModels.filter((modelId) =>
      llmModelKeys.has(normalizeModelIdForMatch(modelId))
    )
  );

  const nextMap = new Map();

  // Retain existing models that are still available
  for (const [modelKey, upstreamModel] of existingKeys.entries()) {
    const resolvedUpstreamModel = availableModelSet.has(upstreamModel)
      ? upstreamModel
      : availableModelByKey.get(modelKey);

    if (!resolvedUpstreamModel) {
      continue;
    }

    nextMap.set(modelKey, resolvedUpstreamModel);
  }

  const mappedValues = new Set(nextMap.values());

  // Add new chat models
  for (const upstreamModel of allAvailableModels) {
    if (mappedValues.has(upstreamModel)) {
      continue;
    }

    if (!availableLlmModelSet.has(upstreamModel)) {
      continue;
    }

    const baseModelKey = toModelKey(upstreamModel);
    if (IGNORED_MODEL_KEYS.has(baseModelKey)) {
      continue;
    }

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

async function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const modelsDir = resolve(scriptDir, "../models");

  // Build existing model map from JSON files to preserve existing keys
  const index = buildModelIndex(modelsDir);
  const existingKeys = new Map();
  for (const [modelId, entry] of Object.entries(index)) {
    const providers = entry.data.providers || [];
    if (providers.includes(PROVIDER_NAME)) {
      const upstream = getProviderUpstream(entry.data, PROVIDER_NAME, modelId);
      existingKeys.set(modelId, upstream);
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

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
