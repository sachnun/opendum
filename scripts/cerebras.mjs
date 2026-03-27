#!/usr/bin/env node

/**
 * Sync Cerebras model availability into TOML registry.
 *
 * Data source: Cerebras Inference API /v1/models endpoint
 *   https://api.cerebras.ai/v1/models
 *
 * Requires CEREBRAS_API_KEY environment variable.
 * Falls back to a known static model list when no key is available.
 *
 * Usage:
 *   CEREBRAS_API_KEY=csk-... node scripts/cerebras.mjs
 *   node scripts/cerebras.mjs          # uses static fallback
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { syncProviderToToml, buildTomlIndex } from "./toml-utils.mjs";

const CEREBRAS_MODELS_URL = "https://api.cerebras.ai/v1/models";
const FETCH_TIMEOUT_MS = 15_000;
const MAX_FETCH_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Static fallback — kept in sync with Cerebras docs.
// Used when CEREBRAS_API_KEY is not set.
// ---------------------------------------------------------------------------

const STATIC_MODELS = [
  "llama3.1-8b",
  "gpt-oss-120b",
  "qwen-3-235b-a22b-instruct-2507",
  "zai-glm-4.7",
];

// ---------------------------------------------------------------------------
// Model key overrides: cerebras upstream ID → canonical TOML key
// Cerebras uses non-standard model IDs that don't match our canonical keys.
// ---------------------------------------------------------------------------

const MODEL_KEY_OVERRIDES = {
  "llama3.1-8b": "llama-3.1-8b-instruct",
  "qwen-3-235b-a22b-instruct-2507": "qwen3-235b-a22b",
  "zai-glm-4.7": "glm-4.7",
};

// ---------------------------------------------------------------------------
// Build reverse map: cerebrasUpstreamId → canonicalModelKey from TOMLs
// ---------------------------------------------------------------------------

function buildReverseMap(modelsDir) {
  const index = buildTomlIndex(modelsDir);
  const reverseMap = new Map();

  for (const [modelId, entry] of Object.entries(index)) {
    const providers = entry.data.opendum?.providers || [];
    if (!providers.includes("cerebras")) continue;

    const upstream = entry.data.opendum?.upstream?.cerebras || modelId;
    reverseMap.set(upstream, modelId);
  }

  return reverseMap;
}

// ---------------------------------------------------------------------------
// Derive a canonical model key from a Cerebras upstream model ID.
// ---------------------------------------------------------------------------

function toModelKey(cerebrasModelId, reverseMap) {
  if (MODEL_KEY_OVERRIDES[cerebrasModelId]) {
    return MODEL_KEY_OVERRIDES[cerebrasModelId];
  }

  if (reverseMap.has(cerebrasModelId)) {
    return reverseMap.get(cerebrasModelId);
  }

  return cerebrasModelId
    .replace(/[:/]/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-{2,}/g, "-");
}

// ---------------------------------------------------------------------------
// Fetch live Cerebras models from API (requires API key)
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

async function fetchCerebrasModels(apiKey) {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(CEREBRAS_MODELS_URL, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(
          `Failed to fetch Cerebras models (${response.status} ${response.statusText})`
        );
      }

      const payload = await response.json();
      if (!payload || !Array.isArray(payload.data)) {
        throw new Error("Unexpected Cerebras /v1/models payload format");
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
    : new Error("Failed to fetch Cerebras model list");
}

// ---------------------------------------------------------------------------
// Build the model map: canonicalKey → cerebrasUpstreamId
// ---------------------------------------------------------------------------

function buildModelMap(cerebrasModelIds, reverseMap) {
  const map = new Map();

  for (const cerebrasId of cerebrasModelIds) {
    const modelKey = toModelKey(cerebrasId, reverseMap);
    map.set(modelKey, cerebrasId);
  }

  return new Map([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const modelsDir = resolve(scriptDir, "../packages/shared/models");

  const reverseMap = buildReverseMap(modelsDir);

  const apiKey = process.env.CEREBRAS_API_KEY;
  let cerebrasModelIds;

  if (apiKey) {
    cerebrasModelIds = await fetchCerebrasModels(apiKey);
  } else {
    console.log("CEREBRAS_API_KEY not set, using static model list.");
    cerebrasModelIds = STATIC_MODELS;
  }

  const modelMap = buildModelMap(cerebrasModelIds, reverseMap);

  const result = syncProviderToToml(modelsDir, "cerebras", modelMap);

  if (result.added.length === 0 && result.removed.length === 0 && result.updated.length === 0) {
    console.log(`Cerebras models are already up to date (${modelMap.size} models).`);
  } else {
    console.log(`Cerebras: ${modelMap.size} models (added ${result.added.length}, removed ${result.removed.length}, updated ${result.updated.length}).`);
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
