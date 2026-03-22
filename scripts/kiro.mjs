#!/usr/bin/env node

/**
 * Kiro model discovery script.
 *
 * Fetches model definitions from the pi-provider-kiro GitHub repo
 * (https://github.com/mikeyobrien/pi-provider-kiro) which maintains an
 * up-to-date list of Kiro model IDs sourced from the official Kiro API,
 * then syncs them into the TOML model registry.
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

const PI_PROVIDER_MODELS_URL =
  "https://raw.githubusercontent.com/mikeyobrien/pi-provider-kiro/main/src/models.ts";
const FETCH_TIMEOUT_MS = 20_000;
const MAX_FETCH_ATTEMPTS = 3;
const PROVIDER_NAME = "kiro";

// Model IDs to skip
const IGNORED_MODEL_IDS = new Set([
  "auto", // Router, not a real model
]);

// Kiro modelId → canonical TOML model key (only when they differ)
const MODEL_KEY_OVERRIDES = {
  "agi-nova-beta-1m": "agi-nova-beta",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Fetch & parse pi-provider-kiro models.ts
// ---------------------------------------------------------------------------

/**
 * Fetch models.ts from pi-provider-kiro and extract KIRO_MODEL_IDS.
 *
 * @returns {Promise<string[]>}  Array of Kiro model IDs (e.g. "claude-sonnet-4.5")
 */
async function fetchModelIds() {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(PI_PROVIDER_MODELS_URL, {
        headers: { Accept: "text/plain" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(
          `Failed to fetch pi-provider-kiro models.ts: ${response.status} ${response.statusText}`
        );
      }

      const source = await response.text();
      return parseModelIds(source);
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
    : new Error("Failed to fetch Kiro model list");
}

/**
 * Parse the KIRO_MODEL_IDS set from the TypeScript source.
 *
 * Looks for lines like:  "claude-sonnet-4.5",
 * inside the `KIRO_MODEL_IDS = new Set([...])` block.
 *
 * @param {string} source  TypeScript source code
 * @returns {string[]}
 */
function parseModelIds(source) {
  // Extract the Set([...]) block
  const setMatch = source.match(
    /KIRO_MODEL_IDS\s*=\s*new\s+Set\(\[\s*([\s\S]*?)\]\)/
  );
  if (!setMatch) {
    throw new Error(
      "Could not find KIRO_MODEL_IDS in pi-provider-kiro models.ts"
    );
  }

  const ids = [];
  // Match each quoted string inside the set
  for (const m of setMatch[1].matchAll(/"([^"]+)"/g)) {
    ids.push(m[1]);
  }

  if (ids.length === 0) {
    throw new Error("KIRO_MODEL_IDS is empty in pi-provider-kiro models.ts");
  }

  return ids;
}

// ---------------------------------------------------------------------------
// Model ID → canonical key mapping
// ---------------------------------------------------------------------------

/**
 * Convert a Kiro model ID to a canonical TOML model key.
 *
 * Kiro uses dots in version numbers:
 *   "claude-sonnet-4.5"  → "claude-sonnet-4-5"
 *   "glm-4.7-flash"      → "glm-4.7-flash"  (kept as-is)
 *   "deepseek-3.2"       → "deepseek-v3.2"
 *
 * @param {string} kiroModelId
 * @returns {{ key: string, upstream: string }}
 */
function toCanonical(kiroModelId) {
  if (MODEL_KEY_OVERRIDES[kiroModelId]) {
    return {
      key: MODEL_KEY_OVERRIDES[kiroModelId],
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

  // 1. Fetch model IDs from pi-provider-kiro
  console.log(`[kiro] Fetching models from pi-provider-kiro ...`);
  const rawIds = await fetchModelIds();
  console.log(`[kiro] Found ${rawIds.length} model IDs.`);

  // 2. Build model map: canonical key → Kiro upstream name
  const modelMap = new Map();
  for (const modelId of rawIds) {
    if (IGNORED_MODEL_IDS.has(modelId)) continue;

    const { key, upstream } = toCanonical(modelId);
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

  // 3. Sync into TOML files
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
