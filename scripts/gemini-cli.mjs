#!/usr/bin/env node

/**
 * Gemini CLI model refresh script.
 *
 * Fetches the supported model list from the google-gemini/gemini-cli GitHub
 * repository (VALID_GEMINI_MODELS in models.ts) and syncs them into the TOML
 * registry. Newly created TOML files are enriched with metadata from the
 * public Google Generative Language API.
 */

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTomlIndex, serializeToml, syncProviderToToml } from "./toml-utils.mjs";

const PROVIDER_NAME = "gemini_cli";

// Source of truth: VALID_GEMINI_MODELS set in the Gemini CLI repo
const GEMINI_CLI_MODELS_URL =
  "https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/core/src/config/models.ts";

// Public Gemini API for metadata enrichment (no auth required for listing)
const GEMINI_API_MODELS_URL =
  "https://generativelanguage.googleapis.com/v1beta/models";

const FETCH_TIMEOUT_MS = 20_000;
const MAX_FETCH_ATTEMPTS = 3;

// Models to exclude – internal routing variants, not user-facing
const EXCLUDED_PATTERNS = [
  /-customtools$/,  // internal custom-tools routing variant
];

// Auto / alias model IDs that should not become TOML entries
const EXCLUDED_IDS = new Set([
  "auto-gemini-3",
  "auto-gemini-2.5",
  "auto",
  "pro",
  "flash",
  "flash-lite",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

async function fetchWithRetry(url, headers = {}, label = "resource") {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { Accept: "text/plain", ...headers },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(
          `Failed to fetch ${label} (${response.status} ${response.statusText})`
        );
      }

      return response;
    } catch (error) {
      lastError = error;

      if (attempt < MAX_FETCH_ATTEMPTS) {
        await sleep(attempt * 1_000);
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Failed to fetch ${label}`);
}

// ---------------------------------------------------------------------------
// Source parsing: extract VALID_GEMINI_MODELS from TypeScript
// ---------------------------------------------------------------------------

/**
 * Parse VALID_GEMINI_MODELS from the Gemini CLI models.ts source.
 *
 * Expected shape:
 * ```
 * export const VALID_GEMINI_MODELS = new Set([
 *   PREVIEW_GEMINI_MODEL,
 *   PREVIEW_GEMINI_3_1_MODEL,
 *   ...
 *   DEFAULT_GEMINI_FLASH_LITE_MODEL,
 * ]);
 * ```
 *
 * The set references constants defined earlier in the file. We first collect
 * all `const NAME = 'value'` declarations, then resolve the set members.
 */
function parseValidModels(source) {
  // 1. Collect all string constant assignments
  const constants = new Map();
  const constRegex =
    /export\s+const\s+([A-Z_][A-Z0-9_]*)\s*=\s*['"]([^'"]+)['"]/g;
  let match;

  while ((match = constRegex.exec(source)) !== null) {
    constants.set(match[1], match[2]);
  }

  // 2. Extract VALID_GEMINI_MODELS set members
  const setMatch = source.match(
    /VALID_GEMINI_MODELS\s*=\s*new\s+Set\s*\(\s*\[([\s\S]*?)\]\s*\)/
  );

  if (!setMatch) {
    throw new Error("Could not find VALID_GEMINI_MODELS in source");
  }

  const setBody = setMatch[1];
  const models = new Set();

  // Match either constant references or inline string literals
  const memberRegex = /([A-Z_][A-Z0-9_]*)|['"]([^'"]+)['"]/g;
  let memberMatch;

  while ((memberMatch = memberRegex.exec(setBody)) !== null) {
    const constName = memberMatch[1];
    const literal = memberMatch[2];

    if (constName && constants.has(constName)) {
      models.add(constants.get(constName));
    } else if (literal) {
      models.add(literal);
    }
  }

  return [...models];
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

function isExcluded(modelId) {
  if (EXCLUDED_IDS.has(modelId)) return true;
  return EXCLUDED_PATTERNS.some((pattern) => pattern.test(modelId));
}

// ---------------------------------------------------------------------------
// Model map building
// ---------------------------------------------------------------------------

function buildModelMap(modelIds) {
  const map = new Map();

  for (const modelId of modelIds) {
    if (isExcluded(modelId)) continue;

    // Model key is the model ID itself (gemini-2.5-pro, gemini-3-pro-preview, etc.)
    map.set(modelId, modelId);
  }

  return new Map([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

// ---------------------------------------------------------------------------
// Metadata enrichment from public Gemini API
// ---------------------------------------------------------------------------

/**
 * Fetch model metadata from the public Generative Language API.
 * Returns a Map of modelId → metadata.
 *
 * Uses GEMINI_API_KEY env var if available, otherwise tries without auth
 * (may have reduced rate limits).
 */
async function fetchGeminiApiModels() {
  const apiKey = process.env.GEMINI_API_KEY;
  const url = apiKey
    ? `${GEMINI_API_MODELS_URL}?key=${apiKey}&pageSize=1000`
    : `${GEMINI_API_MODELS_URL}?pageSize=1000`;

  try {
    const response = await fetchWithRetry(
      url,
      { Accept: "application/json" },
      "Gemini API models"
    );
    const payload = await response.json();

    if (!payload || !Array.isArray(payload.models)) {
      console.warn("Gemini API: unexpected payload format, skipping enrichment.");
      return new Map();
    }

    const lookup = new Map();

    for (const model of payload.models) {
      // model.name is like "models/gemini-2.5-pro"
      const id = (model.name || "").replace(/^models\//, "");
      if (id) {
        lookup.set(id, model);
      }
    }

    return lookup;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`Gemini API enrichment skipped: ${msg}`);
    return new Map();
  }
}

// ---------------------------------------------------------------------------
// Fallback metadata for Gemini models when the public API is unavailable.
// Based on known Gemini model family characteristics.
// ---------------------------------------------------------------------------

const FALLBACK_METADATA = [
  {
    test: /^gemini-3.*flash-lite/,
    data: { reasoning: true, tool_call: true, attachment: true, limit: { context: 1_048_576, output: 65_536 } },
  },
  {
    test: /^gemini-3.*flash/,
    data: { reasoning: true, tool_call: true, attachment: true, limit: { context: 1_048_576, output: 65_536 } },
  },
  {
    test: /^gemini-3.*pro/,
    data: { reasoning: true, tool_call: true, attachment: true, limit: { context: 1_048_576, output: 65_536 } },
  },
  {
    test: /^gemini-2\.5-flash-lite/,
    data: { reasoning: true, tool_call: true, attachment: true, limit: { context: 1_048_576, output: 65_536 } },
  },
  {
    test: /^gemini-2\.5-flash/,
    data: { reasoning: true, tool_call: true, attachment: true, limit: { context: 1_048_576, output: 65_536 } },
  },
  {
    test: /^gemini-2\.5-pro/,
    data: { reasoning: true, tool_call: true, attachment: true, limit: { context: 2_000_000, output: 65_000 } },
  },
];

function getFallbackMetadata(modelKey) {
  for (const rule of FALLBACK_METADATA) {
    if (rule.test.test(modelKey)) return rule.data;
  }
  return { reasoning: true, tool_call: true, attachment: true };
}

/**
 * Enrich newly created TOML files with metadata from the Gemini API.
 * Falls back to known model characteristics when the API is unavailable.
 */
function enrichNewModels(modelsDir, addedKeys, apiModels) {
  const index = buildTomlIndex(modelsDir);

  for (const modelKey of addedKeys) {
    const entry = index[modelKey];
    if (!entry) continue;

    // Try to find API metadata via exact match or prefix match
    let meta = apiModels.get(modelKey);
    if (!meta) {
      for (const [apiId, apiMeta] of apiModels.entries()) {
        if (apiId === modelKey || apiId.startsWith(modelKey)) {
          meta = apiMeta;
          break;
        }
      }
    }

    const data = entry.data;

    if (meta) {
      // Enrich from API metadata
      if (modelKey.match(/^gemini-(2\.5|3)/)) {
        data.reasoning = true;
      }

      const methods = meta.supportedGenerationMethods || [];
      if (
        methods.includes("generateContent") ||
        methods.includes("streamGenerateContent")
      ) {
        data.tool_call = true;
      }

      data.attachment = true;

      if (meta.inputTokenLimit || meta.outputTokenLimit) {
        if (!data.limit) data.limit = {};
        if (meta.inputTokenLimit) data.limit.context = meta.inputTokenLimit;
        if (meta.outputTokenLimit) data.limit.output = meta.outputTokenLimit;
      }
    } else {
      // Fallback enrichment based on known Gemini model patterns
      const fallback = getFallbackMetadata(modelKey);
      data.reasoning = fallback.reasoning;
      data.tool_call = fallback.tool_call;
      data.attachment = fallback.attachment;
      if (fallback.limit) {
        data.limit = { ...fallback.limit };
      }
    }

    // Family
    if (!data.opendum) data.opendum = {};
    data.opendum.family = "Gemini";

    writeFileSync(entry.path, serializeToml(data));
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const modelsDir = resolve(scriptDir, "../packages/shared/models");

  // 1. Fetch and parse VALID_GEMINI_MODELS from Gemini CLI source
  const response = await fetchWithRetry(
    GEMINI_CLI_MODELS_URL,
    process.env.GITHUB_TOKEN
      ? { Authorization: `token ${process.env.GITHUB_TOKEN}` }
      : {},
    "Gemini CLI models.ts"
  );
  const source = await response.text();
  const validModels = parseValidModels(source);

  // 2. Build model map (filter out internal/alias models)
  const modelMap = buildModelMap(validModels);

  // 3. Sync to TOML
  const result = syncProviderToToml(modelsDir, PROVIDER_NAME, modelMap);

  // 4. Enrich newly created TOML files with metadata from public Gemini API
  if (result.added.length > 0) {
    const apiModels = await fetchGeminiApiModels();
    enrichNewModels(modelsDir, result.added, apiModels);
  }

  if (
    result.added.length === 0 &&
    result.removed.length === 0 &&
    result.updated.length === 0
  ) {
    console.log(
      `Gemini CLI models are already up to date (${modelMap.size} models).`
    );
  } else {
    console.log(
      `Gemini CLI: ${modelMap.size} models (added ${result.added.length}, removed ${result.removed.length}, updated ${result.updated.length}).`
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
