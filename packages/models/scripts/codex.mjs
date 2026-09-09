#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { syncProviderModels, buildModelIndex, writeModelJson } from "./model-registry.mjs";
import { sleep, MAX_FETCH_ATTEMPTS, FETCH_TIMEOUT_MS } from "./lib/shared.mjs";

const CODEX_MODELS_URL =
  "https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json";

// Codex's public models feed includes CLI/API variants that are not accepted by
// the ChatGPT-backed Codex account flow used by this project. Filter by
// visibility and supported_in_api; only exclude models that are known to be
// rejected by the ChatGPT Codex backend despite being visible in the feed.
//
// Maintaining a small exclusion list (rather than a whitelist) means new models
// appear automatically when OpenAI adds them to the feed with visibility "list".
const CHATGPT_EXCLUDED_MODELS = new Set([
  "gpt-5.2",
]);

// Models that need a paid ChatGPT plan in Codex. They stay in the registry so
// the dashboard can list them and dim them for free-tier accounts (the same
// pattern as Kiro paid models). Classification comes from official Codex
// pricing docs, not from the feed's `available_in_plans` (which is unreliable
// for free-tier gating).
const PAID_CODEX_TIERS = [
  "plus",
  "pro",
  "pro+",
  "business",
  "enterprise",
  "team",
  "student",
];
const PAID_CHATGPT_MODELS = new Map([
  ["gpt-6-astra", PAID_CODEX_TIERS],
  ["gpt-5.6-sol", PAID_CODEX_TIERS],
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    if (CHATGPT_EXCLUDED_MODELS.has(m.slug)) return false;
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

  return new Map([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Build per-model provider config with tier restrictions.
 *
 * Models in the paid map get `allowedTiers` restricted to non-free plans, which
 * makes the dashboard dim them for free-tier accounts (same pattern as the
 * Kiro provider). Everything else is usable by all tiers and gets no rule.
 */
function buildProviderTierConfig(models) {
  const providerConfigByModel = new Map();

  for (const model of models) {
    const tiers = PAID_CHATGPT_MODELS.get(model.slug);
    if (tiers) {
      providerConfigByModel.set(model.slug, { allowedTiers: tiers });
    }
  }

  return providerConfigByModel;
}

// ---------------------------------------------------------------------------
// Metadata enrichment for newly created JSON files
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
 * After syncProviderModels creates bare-bones JSON files for new models,
 * enrich them with metadata from models.json.
 */
function enrichNewModels(modelsDir, addedKeys, metadataLookup) {
  const index = buildModelIndex(modelsDir);

  for (const modelKey of addedKeys) {
    const entry = Object.values(index).find((item) => item.fileId === modelKey || item.id === modelKey);
    if (!entry) continue;

    const meta = metadataLookup.get(modelKey);
    if (!meta) continue;

    const data = entry.data;

    // reasoning
    const hasReasoning =
      Array.isArray(meta.supported_reasoning_levels) &&
      meta.supported_reasoning_levels.length > 0;
    if (!data.meta) data.meta = {};
    if (hasReasoning) data.meta.reasoning = true;

    // tool_call (if shell_type exists, model supports tool use)
    if (meta.shell_type) data.meta.toolCall = true;

    // attachment / vision (input_modalities includes "image")
    const inputModalities = Array.isArray(meta.input_modalities)
      ? meta.input_modalities
      : [];
    data.meta.vision = inputModalities.includes("image");

    writeModelJson(entry.path, data);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const modelsDir = resolve(scriptDir, "../data");

  const allModels = await fetchCodexModels();
  const filtered = filterModels(allModels);
  const modelMap = buildModelMap(filtered);
  const metadataLookup = buildMetadataLookup(filtered);

  const excludedInFeed = [...CHATGPT_EXCLUDED_MODELS]
    .filter((slug) => metadataLookup.has(slug))
    .sort((a, b) => a.localeCompare(b));

  if (excludedInFeed.length > 0) {
    console.warn(
      `[codex] Excluded models are still listed in the source feed: ${excludedInFeed.join(
        ", "
      )}`
    );
  }

  const providerConfigByModel = buildProviderTierConfig(filtered);
  const result = syncProviderModels(modelsDir, "codex", modelMap, {
    providerConfigByModel,
    managedProviderConfigKeys: ["allowedTiers"],
  });

  // Enrich newly created JSON files with metadata from models.json
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
