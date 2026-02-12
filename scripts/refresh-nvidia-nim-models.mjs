#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const NVIDIA_MODELS_URL = "https://integrate.api.nvidia.com/v1/models";
const FETCH_TIMEOUT_MS = 20_000;
const MAX_FETCH_ATTEMPTS = 3;
const MODEL_MAP_EXPORT_PATTERN =
  /export const NVIDIA_NIM_MODEL_MAP: Record<string, string> = \{[\s\S]*?\n\};/;

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
  return modelId
    .replace(/^library\//, "")
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

function parseExistingModelMap(fileContent) {
  const blockMatch = fileContent.match(MODEL_MAP_EXPORT_PATTERN);
  if (!blockMatch) {
    throw new Error("Could not locate NVIDIA_NIM_MODEL_MAP export block");
  }

  const entries = [...blockMatch[0].matchAll(/"([^"]+)":\s*"([^"]+)",/g)];
  return new Map(entries.map((entry) => [entry[1], entry[2]]));
}

function buildModelMap(modelIds, existingMap) {
  const allAvailableModels = [...new Set(modelIds)].sort((a, b) => a.localeCompare(b));
  const availableChatCandidateSet = new Set(
    allAvailableModels.filter((modelId) => !isNonChatModel(modelId))
  );
  const likelyChatSet = new Set(
    allAvailableModels.filter((modelId) => isLikelyChatModel(modelId))
  );

  const nextMap = new Map();

  for (const [modelKey, upstreamModel] of existingMap.entries()) {
    if (!availableChatCandidateSet.has(upstreamModel)) {
      continue;
    }

    nextMap.set(modelKey, upstreamModel);
  }

  const mappedValues = new Set(nextMap.values());

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

function renderModelMap(modelMap) {
  const lines = [...modelMap.entries()].map(
    ([modelKey, upstreamModel]) =>
      `  ${JSON.stringify(modelKey)}: ${JSON.stringify(upstreamModel)},`
  );

  return [
    "export const NVIDIA_NIM_MODEL_MAP: Record<string, string> = {",
    ...lines,
    "};",
  ].join("\n");
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
  const constantsPath = resolve(scriptDir, "../lib/proxy/providers/nvidia-nim/constants.ts");

  const currentFile = readFileSync(constantsPath, "utf8");
  const existingMap = parseExistingModelMap(currentFile);
  const modelIds = await fetchNvidiaModelIds();
  const nextMap = buildModelMap(modelIds, existingMap);
  const nextExportBlock = renderModelMap(nextMap);

  const nextFile = currentFile.replace(MODEL_MAP_EXPORT_PATTERN, nextExportBlock);

  if (nextFile === currentFile) {
    console.log(`Nvidia NIM model map is already up to date (${nextMap.size} keys).`);
    return;
  }

  writeFileSync(constantsPath, nextFile);
  console.log(`Updated Nvidia NIM model map with ${nextMap.size} keys.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
