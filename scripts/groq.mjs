#!/usr/bin/env node

/**
 * Sync Groq model availability into TOML registry.
 *
 * Data source: HuggingFace Partners API (public, no auth required)
 *   https://huggingface.co/api/partners/groq/models
 *
 * This returns only live models with their Groq provider IDs,
 * automatically excluding decommissioned/deprecated models.
 *
 * Usage:
 *   node scripts/groq.mjs
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { syncProviderToToml, buildTomlIndex } from "./toml-utils.mjs";

const HF_PARTNERS_URL = "https://huggingface.co/api/partners/groq/models";
const FETCH_TIMEOUT_MS = 20_000;
const MAX_FETCH_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Models known to be active on Groq but missing from the HF Partners API.
// Maps canonical model key → Groq upstream model ID.
// ---------------------------------------------------------------------------

const FORCED_GROQ_MODELS = {
  "llama-3.1-8b-instruct": "llama-3.1-8b-instant",
};

// ---------------------------------------------------------------------------
// Model key overrides: groq upstream ID → canonical TOML key
// Used when the derived key doesn't match the existing canonical key.
// ---------------------------------------------------------------------------

const MODEL_KEY_OVERRIDES = {
  "moonshotai/kimi-k2-instruct-0905": "kimi-k2-0905",
};

// ---------------------------------------------------------------------------
// Non-chat model patterns to exclude (whisper, TTS, guard, compound, etc.)
// ---------------------------------------------------------------------------

const NON_CHAT_PATTERNS = [
  /whisper/i,
  /orpheus/i,
  /playai-tts/i,
  /guard/i,
  /safeguard/i,
  /compound/i,
];

function isNonChatModel(modelId) {
  return NON_CHAT_PATTERNS.some((pattern) => pattern.test(modelId));
}

// ---------------------------------------------------------------------------
// Derive a canonical model key from a Groq upstream model ID.
// Uses the existing TOML reverse map first, then falls back to stripping
// the provider prefix (e.g. "openai/gpt-oss-120b" → "gpt-oss-120b").
// ---------------------------------------------------------------------------

function toModelKey(groqModelId, reverseMap) {
  // Check explicit overrides first
  if (MODEL_KEY_OVERRIDES[groqModelId]) {
    return MODEL_KEY_OVERRIDES[groqModelId];
  }

  // Check if any existing TOML already maps to this Groq upstream ID
  if (reverseMap.has(groqModelId)) {
    return reverseMap.get(groqModelId);
  }

  // Strip provider prefix if present (e.g. "meta-llama/llama-4-..." → "llama-4-...")
  const slashIndex = groqModelId.indexOf("/");
  const base = slashIndex === -1 ? groqModelId : groqModelId.slice(slashIndex + 1);

  return base
    .replace(/[:/]/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-{2,}/g, "-");
}

// ---------------------------------------------------------------------------
// Build reverse map: groqUpstreamId → canonicalModelKey from existing TOMLs
// ---------------------------------------------------------------------------

function buildReverseMap(modelsDir) {
  const index = buildTomlIndex(modelsDir);
  const reverseMap = new Map();

  for (const [modelId, entry] of Object.entries(index)) {
    const providers = entry.data.opendum?.providers || [];
    if (!providers.includes("groq")) continue;

    const upstream = entry.data.opendum?.upstream?.groq || modelId;
    reverseMap.set(upstream, modelId);
  }

  return reverseMap;
}

// ---------------------------------------------------------------------------
// Fetch live Groq models from HuggingFace Partners API
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

async function fetchHfGroqModels() {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(HF_PARTNERS_URL, {
        headers: {
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(
          `Failed to fetch HF Partners API (${response.status} ${response.statusText})`
        );
      }

      const payload = await response.json();

      // Response shape: { "conversational": { "HfRepoId": { status, providerId } } }
      const groqModelIds = [];

      for (const [, taskModels] of Object.entries(payload)) {
        if (!taskModels || typeof taskModels !== "object") continue;
        for (const [, modelInfo] of Object.entries(taskModels)) {
          if (
            modelInfo &&
            modelInfo.status === "live" &&
            typeof modelInfo.providerId === "string"
          ) {
            groqModelIds.push(modelInfo.providerId);
          }
        }
      }

      return [...new Set(groqModelIds)].sort((a, b) => a.localeCompare(b));
    } catch (error) {
      lastError = error;

      if (attempt < MAX_FETCH_ATTEMPTS) {
        await sleep(attempt * 1_000);
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Failed to fetch Groq models from HuggingFace Partners API");
}

// ---------------------------------------------------------------------------
// Build the model map: canonicalKey → groqUpstreamId
// ---------------------------------------------------------------------------

function buildModelMap(groqModelIds, reverseMap) {
  const map = new Map();

  for (const groqId of groqModelIds) {
    if (isNonChatModel(groqId)) continue;

    const modelKey = toModelKey(groqId, reverseMap);
    map.set(modelKey, groqId);
  }

  // Add forced models that are known to be active but missing from HF
  for (const [modelKey, groqId] of Object.entries(FORCED_GROQ_MODELS)) {
    if (!map.has(modelKey)) {
      map.set(modelKey, groqId);
    }
  }

  return new Map([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const modelsDir = resolve(scriptDir, "../packages/shared/models");

  // Build reverse map from existing TOMLs so we reuse canonical keys
  const reverseMap = buildReverseMap(modelsDir);

  const groqModelIds = await fetchHfGroqModels();
  const modelMap = buildModelMap(groqModelIds, reverseMap);

  const result = syncProviderToToml(modelsDir, "groq", modelMap);

  if (result.added.length === 0 && result.removed.length === 0 && result.updated.length === 0) {
    console.log(`Groq models are already up to date (${modelMap.size} models).`);
  } else {
    console.log(`Groq: ${modelMap.size} models (added ${result.added.length}, removed ${result.removed.length}, updated ${result.updated.length}).`);
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
