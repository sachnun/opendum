#!/usr/bin/env node

/**
 * Antigravity model discovery script.
 *
 * Fetches the supported model list from the opencode-antigravity-auth plugin
 * README — the de-facto source of truth for which models Google exposes via
 * the Antigravity (Cloud Code Assist) backend — and syncs it into the JSON
 * model registry.
 *
 * Source: https://raw.githubusercontent.com/NoeFabris/opencode-antigravity-auth/main/README.md
 *
 * This is analogous to how copilot.mjs scrapes GitHub's model-release-status.yml
 * and kiro.mjs scrapes pi-provider-kiro's models.ts.
 *
 * Usage:
 *   node scripts/antigravity-models.mjs
 *   node scripts/antigravity-models.mjs --dry-run
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { syncProviderModels, buildModelIndex } from "./model-registry.mjs";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const README_URL =
  "https://raw.githubusercontent.com/NoeFabris/opencode-antigravity-auth/main/README.md";
const FETCH_TIMEOUT_MS = 20_000;
const MAX_FETCH_ATTEMPTS = 3;
const PROVIDER_NAME = "antigravity";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, "..");
const modelsDir = resolve(rootDir, "models");

// ---------------------------------------------------------------------------
// Paths to dashboard quota files with hardcoded model references
// ---------------------------------------------------------------------------

const QUOTA_TS_PATH = resolve(
  rootDir,
  "apps/dashboard/server/lib/providers/antigravity/quota.ts"
);

// ---------------------------------------------------------------------------
// Plugin model name -> { key: canonical JSON key, upstream: Antigravity API name }
//
// The plugin README uses `antigravity-` prefixed names. Gemini models need
// explicit overrides because canonical JSON keys differ from the API names
// (e.g. `gemini-3-flash-preview` in JSON vs `gemini-3-flash` in API).
//
// Claude canonical keys strip `-thinking`; upstream names keep it when present.
// ---------------------------------------------------------------------------

const MODEL_NAME_OVERRIDES = {
  "antigravity-gemini-3-pro": {
    key: "gemini-3.1-pro-preview",
    upstream: "gemini-3.1-pro-high",
  },
  "antigravity-gemini-3.1-pro": {
    key: "gemini-3.1-pro-preview",
    upstream: "gemini-3.1-pro-high",
  },
  "antigravity-gemini-3-flash": {
    key: "gemini-3-flash-preview",
    upstream: "gemini-3-flash",
  },
};

// Models present in Antigravity but NOT tracked by the plugin README.
// These are preserved so syncProviderModels() doesn't accidentally drop them.
// Map: canonical JSON key -> upstream API name (same as key if no mapping needed)
const KNOWN_EXTRAS = new Map([
  ["gemini-3.1-flash-image-preview", "gemini-3.1-flash-image"],
  ["gemini-3-pro-image-preview", "gemini-3-pro-image"],
  ["gemini-2.5-flash", "gemini-2.5-flash"],
  ["gemini-2.5-flash-lite", "gemini-2.5-flash-lite"],
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Fetch README
// ---------------------------------------------------------------------------

async function fetchReadme() {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(README_URL, {
        headers: { Accept: "text/plain" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(
          `Failed to fetch README: ${response.status} ${response.statusText}`
        );
      }

      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < MAX_FETCH_ATTEMPTS) {
        console.warn(
          `[antigravity] Attempt ${attempt} failed: ${error.message}. Retrying...`
        );
        await sleep(attempt * 1_000);
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Failed to fetch opencode-antigravity-auth README");
}

// ---------------------------------------------------------------------------
// Parse model names from README markdown table
// ---------------------------------------------------------------------------

/**
 * Extract Antigravity model names from the README markdown table.
 *
 * The README contains a table like:
 *   | `antigravity-claude-sonnet-4-6` | — | Claude Sonnet 4.6 |
 *   | `antigravity-claude-opus-4-6-thinking` | low, max | Claude Opus 4.6 ... |
 *
 * We extract the backtick-quoted model names that start with `antigravity-`.
 *
 * @param {string} readme  Raw README markdown
 * @returns {string[]}     Array of plugin model names
 */
function parseAntigravityModels(readme) {
  const models = [];

  // Match table rows containing backtick-quoted model names with antigravity- prefix
  const regex = /\|\s*`(antigravity-[a-z0-9._-]+)`\s*\|/g;
  let match;

  while ((match = regex.exec(readme)) !== null) {
    models.push(match[1]);
  }

  if (models.length === 0) {
    throw new Error(
      "No antigravity model names found in README. " +
        "The table format may have changed."
    );
  }

  return [...new Set(models)]; // deduplicate
}

// ---------------------------------------------------------------------------
// Plugin model name → canonical key & upstream name
// ---------------------------------------------------------------------------

/**
  * Convert a plugin model name to a canonical JSON key and upstream API name.
 *
 * Rules:
 *   1. Check MODEL_NAME_OVERRIDES first (for Gemini models).
 *   2. Strip `antigravity-` prefix.
 *   3. Strip `-thinking` suffix for the canonical key.
 *   4. Keep the prefix-stripped plugin name as upstream, including `-thinking`.
 *
 * @param {string} pluginName  e.g. "antigravity-claude-opus-4-6-thinking"
 * @returns {{ key: string, upstream: string }}
 */
function toCanonical(pluginName) {
  if (MODEL_NAME_OVERRIDES[pluginName]) {
    return MODEL_NAME_OVERRIDES[pluginName];
  }

  const upstream = pluginName.replace(/^antigravity-/, "");

  const key = upstream.replace(/-thinking$/, "");

  return { key, upstream };
}

// ---------------------------------------------------------------------------
// Sync JSON files
// ---------------------------------------------------------------------------

function syncJson(modelMap, dryRun) {
  if (dryRun) {
    console.log("[antigravity] Dry run - no JSON files modified.");

    // Show what would change
    const index = buildModelIndex(modelsDir);
    const wouldRemove = [];
    const wouldKeep = [];

    for (const [modelId, entry] of Object.entries(index)) {
      const providers = entry.data.providers || [];
      if (!providers.includes(PROVIDER_NAME)) continue;

      if (modelMap.has(modelId)) {
        wouldKeep.push(modelId);
      } else {
        wouldRemove.push(modelId);
      }
    }

    const wouldAdd = [];
    for (const key of modelMap.keys()) {
      const existing = index[key];
      if (!existing || !(existing.data.providers || []).includes(PROVIDER_NAME)) {
        wouldAdd.push(key);
      }
    }

    if (wouldRemove.length > 0) {
      console.log(`  Would REMOVE antigravity from: ${wouldRemove.join(", ")}`);
    }
    if (wouldAdd.length > 0) {
      console.log(`  Would ADD antigravity to: ${wouldAdd.join(", ")}`);
    }
    if (wouldKeep.length > 0) {
      console.log(`  Would KEEP: ${wouldKeep.join(", ")}`);
    }

    return { added: wouldAdd, removed: wouldRemove, updated: [] };
  }

  return syncProviderModels(modelsDir, PROVIDER_NAME, modelMap);
}

// ---------------------------------------------------------------------------
// Update quota.ts — sync hardcoded model references
// ---------------------------------------------------------------------------

/**
 * Update quota.ts to reflect the current Antigravity model lineup.
 *
 * This updates:
 *   - QUOTA_MAX_REQUESTS (per-tier model limits)
 *   - QUOTA_GROUPS (model groupings for shared quota)
 *   - USER_TO_API_MODEL_MAP / API_TO_USER_MODEL_MAP
 *
 * @param {Set<string>} activeClaudeModels  Set of active Claude canonical keys
 * @param {boolean} dryRun
 */
function updateQuotaTs(activeClaudeModels, dryRun) {
  const source = readFileSync(QUOTA_TS_PATH, "utf-8");
  let updated = source;

  // --- 1. Update QUOTA_MAX_REQUESTS ---
  // Remove lines for Claude models no longer in Antigravity
  // Add lines for new Claude models
  const removedModels = ["claude-opus-4-5", "claude-sonnet-4-5"];
  const addedModels = [];

  for (const model of activeClaudeModels) {
    // Check if model already exists in quota
    if (!source.includes(`"${model}"`)) {
      addedModels.push(model);
    }
  }

  for (const model of removedModels) {
    // Remove lines like:    "claude-opus-4-5": 150,
    const lineRegex = new RegExp(`^\\s*"${escapeRegex(model)}":\\s*\\d+,?\\s*\\n`, "gm");
    updated = updated.replace(lineRegex, "");
  }

  // Add new models to each tier block (after the last claude line in each tier)
  for (const model of addedModels) {
    // Find each tier's claude-opus-4-6 line and add the new model after it
    const insertAfterRegex = new RegExp(
      `("claude-opus-4-6":\\s*\\d+,)`,
      "g"
    );
    updated = updated.replace(insertAfterRegex, (match) => {
      return `${match}\n    "${model}": 150,`;
    });
  }

  // --- 2. Update QUOTA_GROUPS.claude.models ---
  for (const model of removedModels) {
    // Remove from the models array: "claude-opus-4-5",  or  "claude-sonnet-4-5",
    const groupLineRegex = new RegExp(
      `\\s*"${escapeRegex(model)}",?\\n`,
      "g"
    );
    updated = updated.replace(groupLineRegex, "\n");
  }

  for (const model of addedModels) {
    // Add after claude-opus-4-6 in the QUOTA_GROUPS models array
    const insertInGroupRegex = /("claude-opus-4-6",)/;
    updated = updated.replace(insertInGroupRegex, (match) => {
      return `${match}\n      "${model}",`;
    });
  }

  // --- 3. Update USER_TO_API_MODEL_MAP ---
  // Remove old opus-4-5 mapping
  const userToApiRemoveRegex =
    /\s*"claude-opus-4-5":\s*"claude-opus-4-5-thinking",\s*\/\/[^\n]*\n/;
  updated = updated.replace(userToApiRemoveRegex, "\n");

  // --- 4. Update API_TO_USER_MODEL_MAP ---
  // Remove old mappings
  const apiToUserRemoveRegex1 =
    /\s*"claude-opus-4-5-thinking":\s*"claude-opus-4-5",\s*\n/;
  updated = updated.replace(apiToUserRemoveRegex1, "\n");

  const apiToUserRemoveRegex2 =
    /\s*"claude-sonnet-4-5-thinking":\s*"claude-sonnet-4-5",\s*\n/;
  updated = updated.replace(apiToUserRemoveRegex2, "\n");

  // Add new sonnet-4-6 mapping if not present
  if (
    activeClaudeModels.has("claude-sonnet-4-6") &&
    !updated.includes('"claude-sonnet-4-6-thinking"')
  ) {
    // Add after claude-opus-4-6-thinking mapping
    updated = updated.replace(
      /("claude-opus-4-6-thinking":\s*"claude-opus-4-6",)/,
      '$1\n  "claude-sonnet-4-6-thinking": "claude-sonnet-4-6",'
    );
  }

  if (updated !== source) {
    if (dryRun) {
      console.log("[antigravity] Would update quota.ts");
    } else {
      writeFileSync(QUOTA_TS_PATH, updated);
      console.log("[antigravity] Updated quota.ts");
    }
  } else {
    console.log("[antigravity] quota.ts already up to date.");
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const verbose =
    process.argv.includes("--verbose") || process.argv.includes("-v");

  // 1. Fetch README from opencode-antigravity-auth
  console.log(
    "[antigravity] Fetching model list from opencode-antigravity-auth ..."
  );
  const readme = await fetchReadme();

  // 2. Parse model names from the markdown table
  const pluginModels = parseAntigravityModels(readme);
  console.log(
    `[antigravity] Found ${pluginModels.length} models in README table.`
  );

  // 3. Build model map: canonical JSON key -> upstream API name
  const modelMap = new Map();
  const activeClaudeModels = new Set();

  for (const pluginName of pluginModels) {
    const { key, upstream } = toCanonical(pluginName);
    modelMap.set(key, upstream);

    if (key.startsWith("claude-")) {
      activeClaudeModels.add(key);
    }
  }

  // 4. Merge KNOWN_EXTRAS (image models, GPT-OSS, etc.)
  for (const [key, upstream] of KNOWN_EXTRAS) {
    if (!modelMap.has(key)) {
      modelMap.set(key, upstream);
    }
  }

  console.log(
    `[antigravity] Total model map: ${modelMap.size} models ` +
      `(${pluginModels.length} from README + ${KNOWN_EXTRAS.size} known extras).`
  );

  if (verbose || dryRun) {
    console.log("\n[antigravity] Model mapping (canonical → upstream):");
    for (const [key, upstream] of [...modelMap.entries()].sort(([a], [b]) =>
      a.localeCompare(b)
    )) {
      console.log(`  ${key}${key !== upstream ? ` → ${upstream}` : ""}`);
    }
    console.log();

    console.log("[antigravity] Active Claude models:", [...activeClaudeModels].join(", "));
    console.log();
  }

  // 5. Sync JSON files
  const result = syncJson(modelMap, dryRun);

  if (
    result.added.length === 0 &&
    result.removed.length === 0 &&
    result.updated.length === 0
  ) {
    console.log(
      `[antigravity] JSON models are already up to date (${modelMap.size} models).`
    );
  } else {
    console.log(
      `[antigravity] Synced ${modelMap.size} models ` +
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

  // 6. Update dashboard quota source with hardcoded model references
  console.log();
  updateQuotaTs(activeClaudeModels, dryRun);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
