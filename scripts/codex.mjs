#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { syncProviderModels, buildModelIndex, writeModelToml } from "./model-registry.mjs";

const CODEX_MODELS_URL =
  "https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json";
const FETCH_TIMEOUT_MS = 20_000;
const MAX_FETCH_ATTEMPTS = 3;

// Codex's public models feed includes CLI/API variants that are not accepted by
// the ChatGPT-backed Codex account flow used by this project. Keep the synced
// `codex` provider registry restricted to the subset we know works here.
const CHATGPT_COMPATIBLE_CODEX_MODELS = new Set([
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.2",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

/**
 * Fetch the public models.json from the openai/codex GitHub repo.
 * Returns the parsed array of model entries.
 */
async function fetchCodexModels() {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(CODEX_MODELS_URL, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(
          `Failed to fetch models (${response.status} ${response.statusText})`
        );
      }

      const payload = await response.json();
      if (!payload || !Array.isArray(payload.models)) {
        throw new Error("Unexpected Codex models.json payload format");
      }

      return payload.models;
    } catch (error) {
      lastError = error;

      if (attempt < MAX_FETCH_ATTEMPTS) {
        await sleep(attempt * 1_000);
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Failed to fetch Codex CLI model list");
}

// ---------------------------------------------------------------------------
// Filter & mapping
// ---------------------------------------------------------------------------

/**
 * Filter models that are visible and supported in API.
 */
function filterModels(models) {
  return models.filter((m) => {
    if (!m.slug || typeof m.slug !== "string") return false;
    if (m.visibility && m.visibility !== "list") return false;
    if (m.supported_in_api === false) return false;
    if (!CHATGPT_COMPATIBLE_CODEX_MODELS.has(m.slug)) return false;
    return true;
  });
}

/**
 * Build the modelKey -> upstreamName map.
 * For Codex the slug is already a clean key so modelKey === slug.
 */
function buildModelMap(models) {
  const map = new Map();

  for (const model of models) {
    map.set(model.slug, model.slug);
  }

  // GPT-5.5 is documented as rolling out to Codex ahead of the public models
  // feed. Keep it in the local registry so ChatGPT-backed Codex accounts can
  // use it during the rollout window.
  if (!map.has("gpt-5.5")) {
    map.set("gpt-5.5", "gpt-5.5");
  }

  return new Map([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

// ---------------------------------------------------------------------------
// Metadata enrichment for newly created TOML files
// ---------------------------------------------------------------------------

/**
 * Build a lookup from slug -> models.json entry for enrichment.
 */
function buildMetadataLookup(models) {
  const lookup = new Map();
  for (const m of models) {
    if (m.slug) lookup.set(m.slug, m);
  }
  return lookup;
}

/**
 * After syncProviderModels creates bare-bones TOML files for new models,
 * enrich them with metadata from models.json.
 */
function enrichNewModels(modelsDir, addedKeys, metadataLookup) {
  const index = buildModelIndex(modelsDir);

  for (const modelKey of addedKeys) {
    const entry = index[modelKey];
    if (!entry) continue;

    const meta = metadataLookup.get(modelKey);
    if (!meta) continue;

    const data = entry.data;

    // reasoning
    const hasReasoning =
      Array.isArray(meta.supported_reasoning_levels) &&
      meta.supported_reasoning_levels.length > 0;
    if (hasReasoning) data.reasoning = true;

    // tool_call (if shell_type exists, model supports tool use)
    if (meta.shell_type) data.tool_call = true;

    // attachment / vision (input_modalities includes "image")
    const inputModalities = Array.isArray(meta.input_modalities)
      ? meta.input_modalities
      : [];
    data.attachment = inputModalities.includes("image");

    // limits
    if (meta.context_window) {
      if (!data.limit) data.limit = {};
      data.limit.context = meta.context_window;
    }

    // family
    if (!data.opendum) data.opendum = {};
    data.opendum.family = "OpenAI";

    writeModelToml(entry.path, data);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const modelsDir = resolve(scriptDir, "../models");

  const allModels = await fetchCodexModels();
  const filtered = filterModels(allModels);
  const modelMap = buildModelMap(filtered);
  const metadataLookup = buildMetadataLookup(filtered);

  const missingCompatibleModels = [...CHATGPT_COMPATIBLE_CODEX_MODELS]
    .filter((slug) => !metadataLookup.has(slug))
    .sort((a, b) => a.localeCompare(b));

  if (missingCompatibleModels.length > 0) {
    console.warn(
      `[codex] Source feed is missing documented ChatGPT-compatible models: ${missingCompatibleModels.join(
        ", "
      )}`
    );
  }

  const result = syncProviderModels(modelsDir, "codex", modelMap);

  // Enrich newly created TOML files with metadata from models.json
  if (result.added.length > 0) {
    enrichNewModels(modelsDir, result.added, metadataLookup);
  }

  if (
    result.added.length === 0 &&
    result.removed.length === 0 &&
    result.updated.length === 0
  ) {
    console.log(
      `Codex CLI models are already up to date (${modelMap.size} models).`
    );
  } else {
    console.log(
      `Codex ChatGPT-compatible models: ${modelMap.size} models (added ${result.added.length}, removed ${result.removed.length}, updated ${result.updated.length}).`
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
