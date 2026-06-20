#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { syncProviderModels } from "./model-registry.mjs";
import { fetchJson, fetchText } from "./lib/shared.mjs";
import { stripParamInfoKey } from "./lib/clean-key.mjs";

const PROVIDER_NAME = "command_code";
const MODELS_API_URL = "https://api.commandcode.ai/provider/v1/models";
const PRICING_DOCS_URL = "https://commandcode.ai/docs/resources/pricing-limits";

// Command Code's "Go" tier ($1/mo plan) is restricted to open-source models.
// The live /provider/v1/models endpoint lists every model but carries no
// tier field, so the open-source set is resolved from the official pricing
// docs ("Open Source Models" table) and intersected with the API by name.
const GO_TIER = "go";

// Minimum number of Go-tier models expected; guards against silent parsing breakage.
const MIN_EXPECTED_MODELS = 15;

function toModelKey(modelId) {
  const slashIndex = modelId.indexOf("/");
  const baseModelId = slashIndex === -1 ? modelId : modelId.slice(slashIndex + 1);

  return stripParamInfoKey(
    baseModelId
      .toLowerCase()
      .replace(/[:/]/g, "-")
      .replace(/[^a-zA-Z0-9._-]/g, "-")
      .replace(/-{2,}/g, "-")
  );
}

function extractOpenSourceModelNames(html) {
  const start = html.indexOf("Open Source Models");
  if (start === -1) {
    throw new Error("Unable to locate 'Open Source Models' section in Command Code pricing docs");
  }
  const end = html.indexOf("Premium Models", start);
  const section = end === -1 ? html.slice(start) : html.slice(start, end);

  const rows = section.match(/<tr>([\s\S]*?)<\/tr>/g) || [];
  const names = new Set();
  for (const row of rows) {
    const cells = row.match(/<td>([\s\S]*?)<\/td>/g) || [];
    if (cells.length === 0) continue;
    // First cell holds the model display name; strip nested tags.
    const name = cells[0].replace(/<[^>]+>/g, "").trim();
    if (name) names.add(name);
  }
  return names;
}

async function fetchGoTierModels() {
  const [apiPayload, docsHtml] = await Promise.all([
    fetchJson(MODELS_API_URL, { label: "Command Code /provider/v1/models" }),
    fetchText(PRICING_DOCS_URL, { label: "Command Code pricing docs", headers: { Accept: "text/html" } }),
  ]);

  if (!apiPayload || !Array.isArray(apiPayload.data)) {
    throw new Error("Unexpected Command Code /provider/v1/models payload format");
  }

  const openSourceNames = extractOpenSourceModelNames(docsHtml);
  if (openSourceNames.size === 0) {
    throw new Error("No open-source models found in Command Code pricing docs");
  }

  const goModels = apiPayload.data
    .filter((item) => item && typeof item === "object" && typeof item.id === "string" && typeof item.name === "string")
    .filter((item) => openSourceNames.has(item.name.trim()))
    .map((item) => ({ id: item.id.trim(), name: item.name.trim() }));

  if (goModels.length < MIN_EXPECTED_MODELS) {
    throw new Error(`Command Code resolved only ${goModels.length} Go-tier models (expected >= ${MIN_EXPECTED_MODELS})`);
  }

  return goModels;
}

function buildModelMap(models) {
  const map = new Map();
  const providerConfigByModel = new Map();

  for (const { id } of models) {
    const baseModelKey = toModelKey(id);
    let modelKey = baseModelKey;
    let suffix = 2;

    while (map.has(modelKey) && map.get(modelKey) !== id) {
      modelKey = `${baseModelKey}-${suffix}`;
      suffix += 1;
    }

    map.set(modelKey, id);
    providerConfigByModel.set(modelKey, { allowedTiers: [GO_TIER] });
  }

  return {
    modelMap: new Map([...map.entries()].sort(([a], [b]) => a.localeCompare(b))),
    providerConfigByModel,
  };
}

async function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const modelsDir = resolve(scriptDir, "../models");

  const models = await fetchGoTierModels();
  const { modelMap, providerConfigByModel } = buildModelMap(models);

  const result = syncProviderModels(modelsDir, PROVIDER_NAME, modelMap, {
    providerConfigByModel,
    managedProviderConfigKeys: ["allowedTiers"],
  });

  if (result.added.length === 0 && result.removed.length === 0 && result.updated.length === 0) {
    console.log(`Command Code Go-tier models are already up to date (${modelMap.size} models).`);
  } else {
    console.log(`Command Code: ${modelMap.size} models (added ${result.added.length}, removed ${result.removed.length}, updated ${result.updated.length}).`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
