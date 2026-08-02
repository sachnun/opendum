#!/usr/bin/env node

/**
 * Sync Cloudflare Workers AI model availability into JSON registry.
 *
 * Data source: Cloudflare's public docs repository (no auth required)
 *   https://github.com/cloudflare/cloudflare-docs/tree/production/src/content/workers-ai-models
 *
 * The account API requires Cloudflare credentials, so the scheduled refresh uses
 * the docs model metadata that powers developers.cloudflare.com.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildModelIndex,
  getProviderUpstream,
  syncProviderModels,
  writeModelJson,
} from "./model-registry.mjs";
import { fetchJson, MAX_FETCH_ATTEMPTS, FETCH_TIMEOUT_MS } from "./lib/shared.mjs";
import { stripParamInfoKey } from "./lib/clean-key.mjs";

const PROVIDER_NAME = "workers_ai";
const WORKERS_AI_MODELS_API_URL = "https://unroxy.koyeb.app/api.github.com/repos/cloudflare/cloudflare-docs/contents/src/content/workers-ai-models?ref=production";
const FETCH_CONCURRENCY = 8;

const MODEL_KEY_OVERRIDES = {
  "@cf/meta/llama-3.1-8b-instruct-fast": "llama-3.1-8b-instruct",
  "@cf/qwen/qwen2.5-coder-32b-instruct": "qwen2.5-coder-32b",
};

const EXCLUDED_MODEL_KEY_TOKENS = ["guard"];

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );

  return results;
}

function getProperty(model, propertyId) {
  const property = Array.isArray(model?.properties)
    ? model.properties.find((item) => item?.property_id === propertyId)
    : null;
  return property?.value;
}

function isTrue(value) {
  return value === true || value === "true";
}

function supportsMessagesInput(value, depth = 0) {
  if (depth > 64 || value === null || value === undefined) return false;
  if (Array.isArray(value)) {
    return value.some((item) => supportsMessagesInput(item, depth + 1));
  }
  if (typeof value !== "object") return false;
  if (value.properties && typeof value.properties === "object" && value.properties.messages) {
    return true;
  }
  return Object.values(value).some((item) => supportsMessagesInput(item, depth + 1));
}

function normalizeModelKey(value) {
  return stripParamInfoKey(
    value
      .replace(/^@[^/]+\//, "")
      .replace(/[:/]/g, "-")
      .replace(/[^a-zA-Z0-9._-]/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^-+|-+$/g, "")
  );
}

function toModelKey(model, slug, reverseMap) {
  const upstream = typeof model?.name === "string" ? model.name.trim() : "";
  if (MODEL_KEY_OVERRIDES[upstream]) return MODEL_KEY_OVERRIDES[upstream];
  if (reverseMap.has(upstream)) return reverseMap.get(upstream);
  if (slug) return normalizeModelKey(slug);

  const lastSlash = upstream.lastIndexOf("/");
  const base = lastSlash === -1 ? upstream : upstream.slice(lastSlash + 1);
  return normalizeModelKey(base);
}

function deriveFamily(modelKey) {
  if (/^kimi-/i.test(modelKey)) return "Moonshot";
  if (/^glm-/i.test(modelKey)) return "Z.AI";
  if (/^gpt-|^o\d/i.test(modelKey)) return "OpenAI";
  if (/^gemma/i.test(modelKey)) return "Gemini";
  if (/^llama|^meta-llama/i.test(modelKey)) return "Meta";
  if (/^qwen|^qwq-/i.test(modelKey)) return "Qwen";
  if (/^deepseek-/i.test(modelKey)) return "DeepSeek";
  if (/^mistral-|^mixtral|^codestral|^devstral|^ministral|^mamba-codestral|^magistral/i.test(modelKey)) return "Mistral";
  if (/^nemotron-/i.test(modelKey)) return "NVIDIA";
  if (/^granite-/i.test(modelKey)) return "IBM";
  if (/^phi-/i.test(modelKey)) return "Microsoft";
  return undefined;
}

function buildMeta(model) {
  return {
    reasoning: isTrue(getProperty(model, "reasoning")),
    toolCall: isTrue(getProperty(model, "function_calling")),
    vision: isTrue(getProperty(model, "vision")),
  };
}

function buildReverseMap(modelsDir) {
  const index = buildModelIndex(modelsDir);
  const reverseMap = new Map();

  for (const [modelId, entry] of Object.entries(index)) {
    const providers = entry.data.providers || [];
    if (!providers.includes(PROVIDER_NAME)) continue;

    const upstream = getProviderUpstream(entry.data, PROVIDER_NAME, modelId);
    reverseMap.set(upstream, entry.id || modelId);
  }

  return reverseMap;
}

function isExistingIgnoredWithoutWorkersAI(index, modelKey) {
  const entry = Object.values(index).find((item) => item.fileId === modelKey || item.id === modelKey);
  if (!entry?.data?.ignored) return false;
  return !(entry.data.providers || []).includes(PROVIDER_NAME);
}

function shouldIncludeModel(model, modelKey, index, existingWorkersAI) {
  if (!model?.name || typeof model.name !== "string" || !model.name.startsWith("@")) {
    return false;
  }
  if (model.task?.name !== "Text Generation") return false;
  if (!supportsMessagesInput(model.schema?.input)) return false;
  if (isTrue(getProperty(model, "lora"))) return false;
  if (getProperty(model, "planned_deprecation_date") && !existingWorkersAI) return false;
  if (isExistingIgnoredWithoutWorkersAI(index, modelKey)) return false;

  const normalizedModelKey = modelKey.toLowerCase();
  return !EXCLUDED_MODEL_KEY_TOKENS.some((token) => normalizedModelKey.includes(token));
}

function buildModelMap(models, modelsDir, reverseMap) {
  const index = buildModelIndex(modelsDir);
  const map = new Map();
  const metadata = new Map();

  for (const item of models) {
    const upstream = typeof item.model?.name === "string" ? item.model.name.trim() : "";
    const existingWorkersAI = reverseMap.has(upstream);
    const modelKey = toModelKey(item.model, item.slug, reverseMap);

    if (!modelKey || !shouldIncludeModel(item.model, modelKey, index, existingWorkersAI)) {
      continue;
    }

    map.set(modelKey, upstream);
    metadata.set(modelKey, {
      family: deriveFamily(modelKey),
      meta: buildMeta(item.model),
    });
  }

  return {
    modelMap: new Map([...map.entries()].sort(([a], [b]) => a.localeCompare(b))),
    metadata,
  };
}

function mergeMissingMeta(target, source) {
  let changed = false;

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;

    if (target[key] === undefined) {
      target[key] = value;
      changed = true;
    }
  }

  return changed;
}

function applyMetadata(modelsDir, metadata) {
  const index = buildModelIndex(modelsDir);
  let updated = 0;

  for (const [modelKey, info] of metadata.entries()) {
    const entry = Object.values(index).find((item) => item.fileId === modelKey || item.id === modelKey);
    if (!entry) continue;

    let changed = false;

    if (!entry.data.meta) {
      entry.data.meta = info.meta;
      changed = true;
    } else if (mergeMissingMeta(entry.data.meta, info.meta)) {
      changed = true;
    }

    if (changed) {
      writeModelJson(entry.path, entry.data);
      updated += 1;
    }
  }

  return updated;
}

async function fetchWorkersAIModelFiles() {
  const files = await fetchJson(WORKERS_AI_MODELS_API_URL);
  if (!Array.isArray(files)) {
    throw new Error("Unexpected Cloudflare Workers AI model file list payload");
  }

  return files
    .filter((file) => file?.type === "file" && typeof file.name === "string" && file.name.endsWith(".json") && typeof file.download_url === "string")
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function fetchWorkersAIModels() {
  const files = await fetchWorkersAIModelFiles();

  return mapWithConcurrency(files, FETCH_CONCURRENCY, async (file) => ({
    slug: file.name.replace(/\.json$/, ""),
    model: await fetchJson(file.download_url),
  }));
}

async function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const modelsDir = resolve(scriptDir, "../models");
  const reverseMap = buildReverseMap(modelsDir);

  const models = await fetchWorkersAIModels();
  const { modelMap, metadata } = buildModelMap(models, modelsDir, reverseMap);
  const result = syncProviderModels(modelsDir, PROVIDER_NAME, modelMap);
  const metadataUpdates = applyMetadata(modelsDir, metadata);

  if (result.added.length === 0 && result.removed.length === 0 && result.updated.length === 0 && metadataUpdates === 0) {
    console.log(`Cloudflare models are already up to date (${modelMap.size} models).`);
  } else {
    console.log(`Cloudflare: ${modelMap.size} models (added ${result.added.length}, removed ${result.removed.length}, updated ${result.updated.length}, metadata ${metadataUpdates}).`);
    if (result.added.length > 0) {
      console.log(`  Added: ${result.added.join(", ")}`);
    }
    if (result.removed.length > 0) {
      console.log(`  Removed: ${result.removed.join(", ")}`);
    }
    if (result.updated.length > 0) {
      console.log(`  Updated: ${result.updated.join(", ")}`);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
