#!/usr/bin/env node

/**
 * Qwen Code model refresh script.
 *
 * Fetches the model list from the QwenLM/qwen-code GitHub repository
 * (QWEN_OAUTH_MODELS in constants.ts) and syncs them into the TOML registry.
 *
 * Because the OAuth model list is a subset of what the portal.qwen.ai API
 * actually accepts, this script uses an additive strategy: it never removes
 * existing qwen_code models from TOML, only adds newly discovered ones.
 */

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTomlIndex, serializeToml, syncProviderToToml } from "./toml-utils.mjs";

const PROVIDER_NAME = "qwen_code";

// Raw URL for the Qwen Code CLI model constants (source of truth for OAuth models)
const QWEN_CONSTANTS_URL =
  "https://raw.githubusercontent.com/QwenLM/qwen-code/main/packages/core/src/models/constants.ts";

const FETCH_TIMEOUT_MS = 20_000;
const MAX_FETCH_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Known mapping: Qwen OAuth model ID → canonical TOML model key
//
// The Qwen Code CLI exposes abstract model IDs (e.g. "coder-model") that
// don't match the standard Qwen model names used in the TOML registry.
// This map translates them. When a new OAuth model appears that isn't in
// this map, the script logs a warning so it can be added manually.
// ---------------------------------------------------------------------------

const OAUTH_MODEL_KEY_MAP = {
  "coder-model": "qwen3.5",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

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
 * Strategy (additive):
 *  1. Start with all existing qwen_code models from TOML (preserves them).
 *  2. Add any new OAuth models found in the source (using OAUTH_MODEL_KEY_MAP).
 *  3. Never remove models – the OAuth list is incomplete by design.
 */
function buildModelMap(oauthModels, existingKeys) {
  const map = new Map(existingKeys);
  const unmapped = [];

  for (const model of oauthModels) {
    const canonicalKey = OAUTH_MODEL_KEY_MAP[model.id];

    if (!canonicalKey) {
      unmapped.push(model.id);
      continue;
    }

    if (!map.has(canonicalKey)) {
      // New model: key = canonical TOML key, value = upstream OAuth model id
      map.set(canonicalKey, model.id);
    }
  }

  if (unmapped.length > 0) {
    console.warn(
      `Qwen Code: ${unmapped.length} unmapped OAuth model(s): ${unmapped.join(", ")}. ` +
        `Add them to OAUTH_MODEL_KEY_MAP in scripts/qwen-code.mjs.`
    );
  }

  return new Map([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

// ---------------------------------------------------------------------------
// Metadata enrichment for newly created TOML files
// ---------------------------------------------------------------------------

function enrichNewModels(modelsDir, addedKeys, oauthModels) {
  const index = buildTomlIndex(modelsDir);
  const lookup = new Map();

  for (const m of oauthModels) {
    const canonicalKey = OAUTH_MODEL_KEY_MAP[m.id];
    if (canonicalKey) lookup.set(canonicalKey, m);
  }

  for (const modelKey of addedKeys) {
    const entry = index[modelKey];
    if (!entry) continue;

    const meta = lookup.get(modelKey);
    if (!meta) continue;

    const data = entry.data;

    // Capabilities
    if (meta.capabilities?.vision) {
      data.attachment = true;
    }

    // Tool call (assumed true for coding models)
    data.tool_call = true;

    // Family
    if (!data.opendum) data.opendum = {};
    data.opendum.family = "Qwen";

    writeFileSync(entry.path, serializeToml(data));
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const modelsDir = resolve(scriptDir, "../packages/shared/models");

  // 1. Fetch and parse OAuth models from Qwen Code CLI source
  const source = await fetchConstantsSource();
  const oauthModels = parseOAuthModels(source);

  // 2. Collect existing qwen_code models from TOML (to preserve them)
  const index = buildTomlIndex(modelsDir);
  const existingKeys = new Map();

  for (const [modelId, entry] of Object.entries(index)) {
    const providers = entry.data.opendum?.providers || [];
    if (providers.includes(PROVIDER_NAME)) {
      const upstream =
        entry.data.opendum?.upstream?.[PROVIDER_NAME] || modelId;
      existingKeys.set(modelId, upstream);
    }
  }

  // 3. Build combined model map (existing + new OAuth models)
  const modelMap = buildModelMap(oauthModels, existingKeys);

  // 4. Sync to TOML
  const result = syncProviderToToml(modelsDir, PROVIDER_NAME, modelMap);

  // 5. Enrich newly created TOML files
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
