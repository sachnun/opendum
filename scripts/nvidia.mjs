#!/usr/bin/env node

import { buildModelIndex, syncProviderModels, getProviderUpstream } from "./model-registry.mjs";
import { fetchJson, fetchText, parseFlags, resolveModelsDir, logSyncResult, uniqueModelKey } from "./lib/shared.mjs";
import { stripParamInfoKey } from "./lib/clean-key.mjs";

const PROVIDER_NAME = "nvidia_nim";
const NVIDIA_MODELS_URL = "https://integrate.api.nvidia.com/v1/models";
const NVIDIA_MODEL_DOCS_URLS = [
  "https://docs.api.nvidia.com/nim/reference/llm-apis",
  "https://docs.api.nvidia.com/nim/reference/multimodal-apis",
  "https://docs.api.nvidia.com/nim/reference/visual-models-apis",
];

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
// Models can opt out by setting `"ignored": true` in their JSON file. There
// is no longer a hard-coded ignore list here.

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

  const normalized = baseModelId
    .replace(/[:/]/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-{2,}/g, "-");

  return stripParamInfoKey(normalized);
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
    const modelKey = uniqueModelKey(nextMap, baseModelKey, upstreamModel);
    nextMap.set(modelKey, upstreamModel);
    mappedValues.add(upstreamModel);
  }

  return new Map([...nextMap.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

async function fetchNvidiaGenerativeModelKeys() {
  const pages = await Promise.all(
    NVIDIA_MODEL_DOCS_URLS.map((url) => fetchText(url, { label: `Nvidia docs (${url})` }))
  );
  const modelKeys = new Set(
    pages.flatMap((page) => [...extractNvidiaGenerativeModelKeys(page)])
  );
  if (modelKeys.size === 0) {
    throw new Error("Unexpected Nvidia model docs payload format");
  }
  return modelKeys;
}

async function fetchNvidiaModelIds() {
  const payload = await fetchJson(NVIDIA_MODELS_URL, { label: "Nvidia NIM /v1/models" });
  if (!payload || !Array.isArray(payload.data)) {
    throw new Error("Unexpected Nvidia /v1/models payload format");
  }
  return payload.data
    .map((item) => (typeof item?.id === "string" ? item.id.trim() : ""))
    .filter((id) => id.length > 0);
}

async function main() {
  const { dryRun } = parseFlags();
  const modelsDir = resolveModelsDir(import.meta.url);

  // Build existing model map from JSON files to preserve existing keys
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

  const result = syncProviderModels(modelsDir, PROVIDER_NAME, nextMap, { dryRun });

  logSyncResult({ label: "[nvidia-nim]", count: nextMap.size, result, would: dryRun });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
