#!/usr/bin/env node

/**
 * GitHub Copilot model discovery script.
 *
 * Fetches the official supported-models table from the GitHub docs repo and
 * syncs it into the TOML model registry.  No authentication is required — the
 * data is publicly available.
 *
 * Source: https://raw.githubusercontent.com/github/docs/main/data/tables/copilot/model-release-status.yml
 *
 * This file only lists models that are **currently supported** by GitHub
 * Copilot.  Retired models are tracked separately in model-deprecation-history.yml
 * and are intentionally excluded.
 *
 * Usage:
 *   node scripts/copilot.mjs
 *   node scripts/copilot.mjs --dry-run
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { syncProviderToToml } from "./toml-utils.mjs";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MODEL_TABLE_URL =
  "https://raw.githubusercontent.com/github/docs/main/data/tables/copilot/model-release-status.yml";
const FETCH_TIMEOUT_MS = 20_000;
const MAX_FETCH_ATTEMPTS = 3;
const PROVIDER_NAME = "copilot";

// ---------------------------------------------------------------------------
// Display name → { canonicalKey, upstreamName }
//
// The YAML table uses human-readable display names like "Claude Opus 4.6".
// The TOML registry uses dash-separated canonical keys like "claude-opus-4-6".
// The Copilot API uses upstream names like "claude-opus-4.6" (dots for Claude,
// identical to the TOML key for most OpenAI/Gemini models).
//
// We derive both from the display name via rules, with a manual override table
// for edge cases.
// ---------------------------------------------------------------------------

/**
 * Manual overrides: display name → { key, upstream }.
 * Only needed when algorithmic derivation would produce the wrong result.
 */
const DISPLAY_NAME_OVERRIDES = {
  // Gemini models — Copilot naming doesn't match TOML key conventions
  "Gemini 2.5 Pro": { key: "gemini-2.5-pro", upstream: "gemini-2.5-pro" },
  "Gemini 3 Flash": { key: "gemini-3-flash-preview", upstream: "gemini-3-flash-preview" },
  "Gemini 3 Pro": { key: "gemini-3-pro-preview", upstream: "gemini-3-pro-preview" },
  "Gemini 3.1 Pro": { key: "gemini-3.1-pro-preview", upstream: "gemini-3.1-pro-preview" },
  // xAI
  "Grok Code Fast 1": { key: "grok-code-fast-1", upstream: "grok-code-fast-1" },
  // Microsoft fine-tuned — These are proprietary Copilot models without
  // existing TOML counterparts. Use lowercase-dashed keys.
  "Raptor mini": { key: "raptor-mini", upstream: "raptor-mini" },
  "Goldeneye": { key: "goldeneye", upstream: "goldeneye" },
  // Fast mode variant
  "Claude Opus 4.6 (fast mode) (preview)": { key: "claude-opus-4-6", upstream: "claude-opus-4.6" },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Fetch model-release-status.yml
// ---------------------------------------------------------------------------

/**
 * Fetch the supported-models table YAML from the GitHub docs repo.
 * @returns {Promise<string>} Raw YAML content.
 */
async function fetchModelTable() {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(MODEL_TABLE_URL, {
        headers: { Accept: "text/plain" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(
          `Failed to fetch model-release-status.yml: ${response.status} ${response.statusText}`
        );
      }

      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < MAX_FETCH_ATTEMPTS) {
        console.warn(
          `[copilot] Attempt ${attempt} failed: ${error.message}. Retrying...`
        );
        await sleep(attempt * 1_000);
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Failed to fetch model-release-status.yml");
}

// ---------------------------------------------------------------------------
// Parse model display names from the YAML table
// ---------------------------------------------------------------------------

/**
 * Extract model display names from model-release-status.yml.
 *
 * The file is a YAML array of objects, each with a `name` field containing the
 * display name. We do a simple regex parse to avoid pulling in a full YAML
 * parser dependency.
 *
 * @param {string} yaml  Raw YAML content
 * @returns {string[]}   Array of display names
 */
function parseModelDisplayNames(yaml) {
  const names = [];

  for (const rawLine of yaml.split("\n")) {
    const line = rawLine.trim();

    // Match YAML entries like: - name: 'GPT-4.1' or   name: 'Claude Opus 4.6'
    const match = line.match(/^-?\s*name:\s*'(.+)'$/);
    if (!match) continue;

    names.push(match[1]);
  }

  if (names.length === 0) {
    throw new Error("No model display names found in model-release-status.yml");
  }

  return names;
}

// ---------------------------------------------------------------------------
// Display name → canonical key & upstream name
// ---------------------------------------------------------------------------

/**
 * Derive the canonical TOML model key and Copilot upstream name from a
 * display name.
 *
 * Algorithm (when no override exists):
 *   1. Lowercase the display name.
 *   2. Replace spaces and special chars with dashes.
 *   3. The upstream name keeps dots in version numbers (e.g. "claude-opus-4.6").
 *   4. The canonical key replaces dots with dashes for Claude models
 *      (e.g. "claude-opus-4-6").
 *   5. Non-Claude models keep dots in both (e.g. "gpt-5.1", "gemini-2.5-pro").
 *
 * @param {string} displayName
 * @returns {{ key: string, upstream: string }}
 */
function toCanonical(displayName) {
  if (DISPLAY_NAME_OVERRIDES[displayName]) {
    return DISPLAY_NAME_OVERRIDES[displayName];
  }

  // Normalize: lowercase, collapse whitespace, replace spaces with dashes
  let name = displayName.toLowerCase().replace(/\s+/g, "-");

  // Strip trailing preview/beta markers for upstream but keep them for mapping
  // (most Copilot models don't have these)

  const upstream = name;

  // For Claude models, replace dots with dashes in the canonical key
  // "claude-opus-4.6" → "claude-opus-4-6"
  let key = name;
  if (key.startsWith("claude-")) {
    key = key.replace(/(\d+)\.(\d+)/g, "$1-$2");
  }

  return { key, upstream };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const verbose =
    process.argv.includes("--verbose") || process.argv.includes("-v");

  // 1. Fetch model-release-status.yml (only currently supported models)
  console.log(`[copilot] Fetching supported models from GitHub docs repo ...`);
  const yaml = await fetchModelTable();

  // 2. Parse display names
  const displayNames = parseModelDisplayNames(yaml);
  console.log(`[copilot] Found ${displayNames.length} supported model display names.`);

  // 3. Build model map: canonical key → upstream name
  const modelMap = new Map();
  const seen = new Set(); // Deduplicate (e.g. fast-mode variants mapping to same key)

  for (const displayName of displayNames) {
    const { key, upstream } = toCanonical(displayName);

    // If we already have this key (e.g. "Claude Opus 4.6" and its fast mode
    // variant both map to "claude-opus-4-6"), keep the first (non-variant) one.
    if (seen.has(key)) continue;
    seen.add(key);

    modelMap.set(key, upstream);
  }

  console.log(`[copilot] Mapped to ${modelMap.size} canonical model keys.`);

  if (verbose || dryRun) {
    console.log("\n[copilot] Model mapping (canonical → upstream):");
    for (const [key, upstream] of [...modelMap.entries()].sort(([a], [b]) =>
      a.localeCompare(b)
    )) {
      console.log(`  ${key}${key !== upstream ? ` → ${upstream}` : ""}`);
    }
    console.log();
  }

  if (dryRun) {
    console.log("[copilot] Dry run — no TOML files modified.");
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
      `[copilot] Models are already up to date (${modelMap.size} models).`
    );
  } else {
    console.log(
      `[copilot] Synced ${modelMap.size} models ` +
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
