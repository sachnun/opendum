#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { syncProviderModels } from "./model-registry.mjs";
import { fetchText, fetchJson, MAX_FETCH_ATTEMPTS, FETCH_TIMEOUT_MS } from "./lib/shared.mjs";
import { stripParamInfoKey } from "./lib/clean-key.mjs";

const PROVIDER_NAME = "siliconflow";
const MODELS_PAGE_URL = "https://www.siliconflow.com/models";
const SEARCH_INDEX_PATTERN = /<meta\s+name="framer-search-index(?:-fallback)?"\s+content="([^"]+)"/g;

// Minimum number of chat models expected; guards against silent parsing breakage.
const MIN_EXPECTED_MODELS = 20;

// Non-chat model id fragments (image / audio / video / embedding / reranker).
const EXCLUDED_ID_TOKENS = [
  "embedding",
  "reranker",
  "rerank",
  "flux",
  "cosyvoice",
  "fish-speech",
  "indextts",
  "wan2",
  "z-image",
  "qwen-image",
  "stable-diffusion",
];

function toModelKey(modelId) {
  const slashIndex = modelId.indexOf("/");
  const baseModelId = slashIndex === -1 ? modelId : modelId.slice(slashIndex + 1);

  return stripParamInfoKey(
    baseModelId
      .toLowerCase()
      .replace(/[:/]/g, "-")
      .replace(/[^a-zA-Z0-9._-]/g, "-")
      .replace(/-{2,}/g, "-")
  );
}

function isChatModelId(modelId) {
  const normalized = modelId.toLowerCase();
  return !EXCLUDED_ID_TOKENS.some((token) => normalized.includes(token));
}

function isCanonicalModelId(value) {
  return typeof value === "string" && /^[\w.-]+\/[\w.-]+$/.test(value.trim());
}

function extractModelIds(searchIndex) {
  if (!searchIndex || typeof searchIndex !== "object") {
    throw new Error("Unexpected SiliconFlow search index payload format");
  }

  const ids = new Set();
  for (const [path, entry] of Object.entries(searchIndex)) {
    if (!path.startsWith("/models/") || path.includes("/compare/")) {
      continue;
    }
    if (!entry || typeof entry !== "object" || !Array.isArray(entry.h2)) {
      continue;
    }
    for (const heading of entry.h2) {
      if (isCanonicalModelId(heading)) {
        ids.add(heading.trim());
      }
    }
  }

  return [...ids];
}

function buildModelMap(modelIds) {
  const map = new Map();

  for (const modelId of modelIds) {
    if (!isChatModelId(modelId)) {
      continue;
    }

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

async function resolveSearchIndexUrls() {
  const html = await fetchText(MODELS_PAGE_URL, {
    label: "SiliconFlow models page",
    headers: { Accept: "text/html" },
  });
  const urls = [];
  const seen = new Set();
  for (const match of html.matchAll(SEARCH_INDEX_PATTERN)) {
    if (match[1] && !seen.has(match[1])) {
      seen.add(match[1]);
      urls.push(match[1]);
    }
  }
  if (urls.length === 0) {
    throw new Error("Unable to locate framer-search-index URL on SiliconFlow models page");
  }
  return urls;
}

async function fetchSiliconFlowChatModelIds() {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt += 1) {
    try {
      const searchIndexUrls = await resolveSearchIndexUrls();
      let searchIndex = null;
      let fetchError = null;

      for (const url of searchIndexUrls) {
        try {
          searchIndex = await fetchJson(url, {
            label: "SiliconFlow search index",
            timeout: FETCH_TIMEOUT_MS,
          });
          break;
        } catch (error) {
          fetchError = error;
        }
      }

      if (!searchIndex) throw fetchError || new Error("All SiliconFlow search index URLs failed");

      const ids = extractModelIds(searchIndex);
      const chatIds = ids.filter(isChatModelId);
      if (chatIds.length < MIN_EXPECTED_MODELS) {
        throw new Error(`SiliconFlow search index returned only ${chatIds.length} chat models (expected >= ${MIN_EXPECTED_MODELS})`);
      }
      return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Failed to fetch SiliconFlow model list");
}

async function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const modelsDir = resolve(scriptDir, "../models");

  const modelIds = await fetchSiliconFlowChatModelIds();
  const modelMap = buildModelMap(modelIds);

  const result = syncProviderModels(modelsDir, PROVIDER_NAME, modelMap);

  if (result.added.length === 0 && result.removed.length === 0 && result.updated.length === 0) {
    console.log(`SiliconFlow models are already up to date (${modelMap.size} models).`);
  } else {
    console.log(`SiliconFlow: ${modelMap.size} models (added ${result.added.length}, removed ${result.removed.length}, updated ${result.updated.length}).`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
