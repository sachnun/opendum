#!/usr/bin/env node

/**
 * Kiro model discovery script.
 *
 * Scrapes the official Kiro documentation page (https://kiro.dev/docs/models/)
 * to discover the current list of officially supported models, then syncs
 * them into the TOML model registry.
 *
 * This ensures only models actually listed in the official Kiro docs are
 * registered as Kiro-provided, preventing INVALID_MODEL_ID errors from
 * model IDs that the Kiro API may not accept for all accounts/regions.
 *
 * Usage:
 *   node scripts/kiro.mjs
 *   node scripts/kiro.mjs --dry-run
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { syncProviderToToml } from "./toml-utils.mjs";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const KIRO_DOCS_URL = "https://kiro.dev/docs/models/";
const FETCH_TIMEOUT_MS = 20_000;
const MAX_FETCH_ATTEMPTS = 3;
const PROVIDER_NAME = "kiro";

// Display names to skip (not real models)
const IGNORED_DISPLAY_NAMES = new Set(["Auto"]);

// Display name → Kiro API model ID overrides (non-standard mappings)
const MODEL_ID_OVERRIDES = {
  "Claude Sonnet 4.0": "claude-sonnet-4",
};

// Models known to have a separate -1m (1M context) variant on the Kiro API.
// The official docs may only list the base model; we add the -1m variant
// for models where the Kiro API accepts it.
const MODELS_WITH_1M_VARIANT = new Set([
  "claude-opus-4.6",
  "claude-sonnet-4.6",
  "claude-sonnet-4.5",
]);

// Kiro modelId → canonical TOML model key (only when they differ)
const TOML_KEY_OVERRIDES = {};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Strip HTML tags and decode common HTML entities.
 * @param {string} html
 * @returns {string}
 */
function stripHtml(html) {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Fetch & parse official Kiro docs
// ---------------------------------------------------------------------------

/**
 * Fetch the official Kiro models page and extract model info from the
 * "Quick comparison" HTML table.
 *
 * @returns {Promise<Array<{name: string, contextWindow: string, region: string}>>}
 */
async function fetchOfficialModels() {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(KIRO_DOCS_URL, {
        headers: {
          Accept: "text/html",
          "User-Agent": "OpendumKiroSync/1.0",
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(
          `Failed to fetch Kiro docs: ${response.status} ${response.statusText}`
        );
      }

      const html = await response.text();
      return parseModelsFromHtml(html);
    } catch (error) {
      lastError = error;
      if (attempt < MAX_FETCH_ATTEMPTS) {
        console.warn(
          `[kiro] Attempt ${attempt} failed: ${error.message}. Retrying...`
        );
        await sleep(attempt * 1_000);
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Failed to fetch Kiro models page");
}

/**
 * Parse model data from the HTML of the Kiro models docs page.
 *
 * Looks for the "Quick comparison" table (the one with "Context window"
 * in its header) and extracts model names, context windows, and regions.
 *
 * @param {string} html  Full HTML of kiro.dev/docs/models/
 * @returns {Array<{name: string, contextWindow: string, region: string}>}
 */
function parseModelsFromHtml(html) {
  // Find all <table> elements
  const tables = [];
  const tableRegex = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  let tableMatch;
  while ((tableMatch = tableRegex.exec(html)) !== null) {
    tables.push(tableMatch[1]);
  }

  if (tables.length === 0) {
    throw new Error(
      "No tables found on Kiro docs page. The page structure may have changed."
    );
  }

  // Find the comparison table (contains "Context window" in header)
  let comparisonTable = null;
  for (const table of tables) {
    if (table.includes("Context window")) {
      comparisonTable = table;
      break;
    }
  }

  if (!comparisonTable) {
    throw new Error(
      'Could not find "Quick comparison" table on Kiro docs page. ' +
        "The page structure may have changed."
    );
  }

  // Parse rows from the table
  const rows = parseTableRows(comparisonTable);
  if (rows.length < 2) {
    throw new Error("Models table has fewer than 2 rows (header + data).");
  }

  // Identify columns by header text
  const header = rows[0].map((h) => h.toLowerCase());
  const nameIdx = header.findIndex(
    (h) => h === "model" || h.includes("model")
  );
  const ctxIdx = header.findIndex((h) => h.includes("context"));
  const regionIdx = header.findIndex((h) => h.includes("region"));

  if (nameIdx < 0) {
    throw new Error("Could not find 'Model' column in comparison table.");
  }

  const models = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const name = row[nameIdx]?.trim();
    if (!name) continue;

    models.push({
      name,
      contextWindow: ctxIdx >= 0 ? (row[ctxIdx]?.trim() || "") : "",
      region: regionIdx >= 0 ? (row[regionIdx]?.trim() || "") : "",
    });
  }

  if (models.length === 0) {
    throw new Error("No models found in comparison table.");
  }

  return models;
}

/**
 * Parse <tr>/<td>/<th> cells from table HTML.
 *
 * @param {string} tableInnerHtml
 * @returns {string[][]}
 */
function parseTableRows(tableInnerHtml) {
  const rows = [];
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;

  while ((rowMatch = rowRegex.exec(tableInnerHtml)) !== null) {
    const cells = [];
    const cellRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let cellMatch;

    while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) {
      cells.push(stripHtml(cellMatch[1]));
    }

    if (cells.length > 0) {
      rows.push(cells);
    }
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Display name → Kiro API model ID
// ---------------------------------------------------------------------------

/**
 * Convert a display name from the Kiro docs to a Kiro API model ID.
 *
 * Examples:
 *   "Claude Opus 4.6"   → "claude-opus-4.6"
 *   "Claude Sonnet 4.0" → "claude-sonnet-4"   (override: Kiro drops .0)
 *   "DeepSeek 3.2"      → "deepseek-3.2"
 *   "MiniMax 2.5"       → "minimax-m2.5"      (Kiro prefixes "m")
 *   "MiniMax 2.1"       → "minimax-m2.1"
 *   "Qwen3 Coder Next"  → "qwen3-coder-next"
 *   "Claude Haiku 4.5"  → "claude-haiku-4.5"
 *
 * @param {string} displayName
 * @returns {string}
 */
function displayNameToKiroId(displayName) {
  if (MODEL_ID_OVERRIDES[displayName]) {
    return MODEL_ID_OVERRIDES[displayName];
  }

  let id = displayName.toLowerCase().replace(/\s+/g, "-");

  // MiniMax: "minimax-2.5" → "minimax-m2.5"
  id = id.replace(/^minimax-(\d)/, "minimax-m$1");

  return id;
}

/**
 * Generate all Kiro API model IDs for a given base model,
 * including -1m (1M context) variants where applicable.
 *
 * @param {string} kiroId  Base Kiro model ID
 * @returns {string[]}
 */
function expandVariants(kiroId) {
  const ids = [kiroId];

  if (MODELS_WITH_1M_VARIANT.has(kiroId)) {
    ids.push(`${kiroId}-1m`);
  }

  return ids;
}

// ---------------------------------------------------------------------------
// Kiro model ID → canonical TOML key
// ---------------------------------------------------------------------------

/**
 * Convert a Kiro API model ID to a canonical TOML model key.
 *
 * Kiro uses dots in version numbers:
 *   "claude-sonnet-4.5"  → "claude-sonnet-4-5"
 *   "deepseek-3.2"       → "deepseek-v3.2"
 *   "minimax-m2.1"       → "minimax-m2.1"   (kept as-is)
 *   "qwen3-coder-next"   → "qwen3-coder-next"
 *
 * @param {string} kiroModelId
 * @returns {{ key: string, upstream: string }}
 */
function toCanonical(kiroModelId) {
  if (TOML_KEY_OVERRIDES[kiroModelId]) {
    return {
      key: TOML_KEY_OVERRIDES[kiroModelId],
      upstream: kiroModelId,
    };
  }

  let key = kiroModelId;

  // Claude: "claude-sonnet-4.5" → "claude-sonnet-4-5"
  if (key.startsWith("claude-")) {
    key = key.replace(/(\d+)\.(\d+)/g, "$1-$2");
  }

  // DeepSeek: "deepseek-3.2" → "deepseek-v3.2"
  if (key.startsWith("deepseek-") && /^deepseek-\d/.test(key)) {
    key = key.replace(/^deepseek-/, "deepseek-v");
  }

  return { key, upstream: kiroModelId };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const verbose =
    process.argv.includes("--verbose") || process.argv.includes("-v");

  // 1. Fetch models from official Kiro docs
  console.log(`[kiro] Fetching models from ${KIRO_DOCS_URL} ...`);
  const officialModels = await fetchOfficialModels();
  console.log(
    `[kiro] Found ${officialModels.length} models on docs page: ${officialModels.map((m) => m.name).join(", ")}`
  );

  // 2. Convert display names to Kiro API model IDs
  const allKiroIds = [];
  for (const model of officialModels) {
    if (IGNORED_DISPLAY_NAMES.has(model.name)) {
      if (verbose) {
        console.log(`[kiro] Skipping "${model.name}" (ignored)`);
      }
      continue;
    }

    const baseId = displayNameToKiroId(model.name);
    const variants = expandVariants(baseId);
    allKiroIds.push(...variants);

    if (verbose) {
      console.log(
        `[kiro]   "${model.name}" → ${variants.join(", ")}` +
          (model.region ? ` (${model.region})` : "")
      );
    }
  }

  console.log(`[kiro] Generated ${allKiroIds.length} Kiro API model IDs.`);

  // 3. Build model map: canonical key → Kiro upstream name
  const modelMap = new Map();
  for (const kiroId of allKiroIds) {
    const { key, upstream } = toCanonical(kiroId);
    modelMap.set(key, upstream);
  }

  console.log(`[kiro] Mapped to ${modelMap.size} canonical model keys.`);

  if (verbose || dryRun) {
    console.log("\n[kiro] Model mapping (canonical → upstream):");
    for (const [key, upstream] of [...modelMap.entries()].sort(([a], [b]) =>
      a.localeCompare(b)
    )) {
      console.log(`  ${key}${key !== upstream ? ` → ${upstream}` : ""}`);
    }
    console.log();
  }

  if (dryRun) {
    console.log("[kiro] Dry run — no TOML files modified.");
    return;
  }

  // 4. Sync into TOML files
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const modelsDir = resolve(scriptDir, "../packages/shared/models");

  const result = syncProviderToToml(modelsDir, PROVIDER_NAME, modelMap);

  if (
    result.added.length === 0 &&
    result.removed.length === 0 &&
    result.updated.length === 0
  ) {
    console.log(
      `[kiro] Models are already up to date (${modelMap.size} models).`
    );
  } else {
    console.log(
      `[kiro] Synced ${modelMap.size} models ` +
        `(added: ${result.added.length}, removed: ${result.removed.length}, updated: ${result.updated.length}).`
    );
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
