#!/usr/bin/env node

/**
 * Qwen Code model refresh script.
 *
 * Fetches the OAuth model list from the QwenLM/qwen-code GitHub repository
 * (`QWEN_OAUTH_MODELS` in `packages/core/src/models/constants.ts`) and syncs
 * them into the JSON registry.
 *
 * The upstream exposes abstract model IDs (e.g. `coder-model`) whose real
 * identity lives in the human-readable `description` field, which the Qwen
 * team updates whenever they swap the underlying model. We auto-derive the
 * canonical JSON key from that description so this script picks up the
 * latest model without any manual mapping maintenance.
 *
 * Source of truth:
 *   https://raw.githubusercontent.com/QwenLM/qwen-code/main/packages/core/src/models/constants.ts
 *
 * Strategy:
 *   - Additive for models not yet in the registry.
 *   - Strips `qwen_code` from any existing entry whose key no longer matches
 *     an upstream model (so the previous alias becomes an empty stub).
 *   - `description`-based derivation handles known variants: Plus, Flash,
 *     Max, Pro, Ultra, Lite. If a new variant appears, the script logs a
 *     warning; update `deriveCanonicalKey()` to extend the regex.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildModelIndex, syncProviderModels, writeModelJson, getProviderUpstream } from "./model-registry.mjs";
import { sleep, MAX_FETCH_ATTEMPTS, FETCH_TIMEOUT_MS } from "./lib/shared.mjs";

const PROVIDER_NAME = "qwen_code";

// Raw URL for the Qwen Code CLI model constants (source of truth for OAuth models)
const QWEN_CONSTANTS_URL =
  "https://raw.githubusercontent.com/QwenLM/qwen-code/main/packages/core/src/models/constants.ts";

// ---------------------------------------------------------------------------
// Canonical key derivation
//
// Qwen Code upstream writes descriptions like:
//   "Qwen 3.6 Plus — efficient hybrid model ..."    → "qwen3.6-plus"
//   "Qwen 3.5 — flagship ..."                        → "qwen3.5"
//   "Qwen 3.7 Max — agentic ..."                     → "qwen3.7-max"
//
// We parse the leading "Qwen X.Y [<variant>]" so this script stays in sync
// whenever Qwen swaps the underlying model of `coder-model`.
// ---------------------------------------------------------------------------

const KNOWN_VARIANTS = ["Plus", "Flash", "Max", "Pro", "Ultra", "Lite"];

function deriveCanonicalKey(oauthModel) {
  const description =
    typeof oauthModel.description === "string" ? oauthModel.description : "";
  const variantGroup = KNOWN_VARIANTS.join("|");
  const match = description.match(
    new RegExp(`^\\s*Qwen\\s+(\\d+(?:\\.\\d+)?)(?:\\s+(${variantGroup}))?\\b`, "i")
  );
  if (!match) return null;

  const version = match[1];
  const variant = match[2];

  if (variant) {
    return `qwen${version}-${variant.toLowerCase()}`;
  }
  return `qwen${version}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fetch the raw TypeScript source of the Qwen Code model constants.
 */
async function fetchConstantsSource() {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(QWEN_CONSTANTS_URL, {
        headers: {
          Accept: "text/plain",
          ...(process.env.GITHUB_TOKEN
            ? { Authorization: `token ${process.env.GITHUB_TOKEN}` }
            : {}),
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(
          `Failed to fetch constants.ts (${response.status} ${response.statusText})`
        );
      }

      return await response.text();
    } catch (error) {
      lastError = error;

      if (attempt < MAX_FETCH_ATTEMPTS) {
        await sleep(attempt * 1_000);
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Failed to fetch Qwen Code constants source");
}

// ---------------------------------------------------------------------------
// Source parsing
// ---------------------------------------------------------------------------

/**
 * Parse QWEN_OAUTH_MODELS from the TypeScript source.
 *
 * Expected shape (may evolve):
 * ```
 * export const QWEN_OAUTH_MODELS: ModelConfig[] = [
 *   {
 *     id: 'coder-model',
 *     name: 'coder-model',
 *     description: '...',
 *     capabilities: { vision: true },
 *   },
 * ];
 * ```
 *
 * Returns an array of { id, name, description, capabilities }.
 */
function parseOAuthModels(source) {
  // Extract the array body between the opening [ and closing ];
  const arrayMatch = source.match(
    /QWEN_OAUTH_MODELS[\s\S]*?=\s*\[([\s\S]*?)\];/
  );

  if (!arrayMatch) {
    throw new Error("Could not find QWEN_OAUTH_MODELS in source");
  }

  const arrayBody = arrayMatch[1];
  const models = [];

  // Match each object literal { ... } in the array
  const objectRegex = /\{([^}]+)\}/g;
  let objMatch;

  while ((objMatch = objectRegex.exec(arrayBody)) !== null) {
    const objBody = objMatch[1];
    const model = {};

    // Extract string fields: id, name, description
    for (const field of ["id", "name", "description"]) {
      const fieldMatch = objBody.match(
        new RegExp(`${field}\\s*:\\s*['"]([^'"]*?)['"]`)
      );
      if (fieldMatch) {
        model[field] = fieldMatch[1];
      }
    }

    // Extract capabilities object
    const capMatch = objBody.match(/capabilities\s*:\s*\{([^}]*)\}/);
    if (capMatch) {
      model.capabilities = {};
      const visionMatch = capMatch[1].match(/vision\s*:\s*(true|false)/);
      if (visionMatch) {
        model.capabilities.vision = visionMatch[1] === "true";
      }
    }

    if (model.id) {
      models.push(model);
    }
  }

  return models;
}

// ---------------------------------------------------------------------------
// Model map building
// ---------------------------------------------------------------------------

/**
 * Build the modelKey → upstreamName map.
 *
 * Strategy:
 *  1. Start from existing `qwen_code` registry entries, but only keep those
 *     whose `upstream` field still points to an ID offered by Qwen Code
 *     today. Stale entries (whose upstream no longer matches anything in
 *     the OAuth list) fall out so the registry reflects the latest upstream.
 *  2. Derive the canonical JSON key from each OAuth model's `description`
 *     and add it to the map if not already present.
 *  3. Models whose description we cannot parse are logged as warnings so the
 *     regex in `deriveCanonicalKey()` can be extended.
 */
function buildModelMap(oauthModels, existingKeys) {
  const validUpstreamIds = new Set(oauthModels.map((m) => m.id));
  const map = new Map();

  for (const [key, upstream] of existingKeys) {
    if (validUpstreamIds.has(upstream)) {
      map.set(key, upstream);
    }
  }

  const unmapped = [];

  for (const model of oauthModels) {
    const canonicalKey = deriveCanonicalKey(model);

    if (!canonicalKey) {
      unmapped.push({ id: model.id, description: model.description });
      continue;
    }

    if (!map.has(canonicalKey)) {
      // New model: key = canonical JSON key, value = upstream OAuth model id
      map.set(canonicalKey, model.id);
    }
  }

  if (unmapped.length > 0) {
    console.warn(
      `Qwen Code: ${unmapped.length} OAuth model(s) could not be derived from description:\n` +
        unmapped
          .map((m) => `  - ${m.id}: "${m.description ?? ""}"`)
          .join("\n") +
        `\nExtend the variant list / regex in deriveCanonicalKey().`
    );
  }

  return new Map([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

// ---------------------------------------------------------------------------
// Metadata enrichment for newly created JSON files
// ---------------------------------------------------------------------------

function enrichNewModels(modelsDir, addedKeys, oauthModels) {
  const index = buildModelIndex(modelsDir);
  const lookup = new Map();

  for (const m of oauthModels) {
    const canonicalKey = deriveCanonicalKey(m);
    if (canonicalKey) lookup.set(canonicalKey, m);
  }

  for (const modelKey of addedKeys) {
    const entry = Object.values(index).find((item) => item.fileId === modelKey || item.id === modelKey);
    if (!entry) continue;

    const meta = lookup.get(modelKey);
    if (!meta) continue;

    const data = entry.data;
    if (!data.meta) data.meta = {};

    // Capabilities
    if (meta.capabilities?.vision) {
      data.meta.vision = true;
    }

    // Tool call (assumed true for coding models)
    data.meta.toolCall = true;

    // Family
    data.family = "Qwen";

    writeModelJson(entry.path, data);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const modelsDir = resolve(scriptDir, "../models");

  // 1. Fetch and parse OAuth models from Qwen Code CLI source
  const source = await fetchConstantsSource();
  const oauthModels = parseOAuthModels(source);

  // 2. Collect existing qwen_code models from JSON (to preserve them)
  const index = buildModelIndex(modelsDir);
  const existingKeys = new Map();

  for (const [modelId, entry] of Object.entries(index)) {
    const providers = entry.data.providers || [];
    if (providers.includes(PROVIDER_NAME)) {
      const upstream = getProviderUpstream(entry.data, PROVIDER_NAME, modelId);
      existingKeys.set(entry.id || modelId, upstream);
    }
  }

  // 3. Build combined model map (existing + new OAuth models)
  const modelMap = buildModelMap(oauthModels, existingKeys);

  // 4. Sync to JSON registry
  const result = syncProviderModels(modelsDir, PROVIDER_NAME, modelMap);

  // 5. Enrich newly created JSON files
  if (result.added.length > 0) {
    enrichNewModels(modelsDir, result.added, oauthModels);
  }

  if (
    result.added.length === 0 &&
    result.removed.length === 0 &&
    result.updated.length === 0
  ) {
    console.log(
      `Qwen Code models are already up to date (${modelMap.size} models, ${oauthModels.length} OAuth source models).`
    );
  } else {
    console.log(
      `Qwen Code: ${modelMap.size} models (added ${result.added.length}, removed ${result.removed.length}, updated ${result.updated.length}).`
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
