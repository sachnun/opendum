#!/usr/bin/env node

import { syncProviderModels } from "./model-registry.mjs";
import { fetchJson, fetchText, parseFlags, resolveModelsDir, logSyncResult, uniqueModelKey } from "./lib/shared.mjs";
import { stripParamInfoKey } from "./lib/clean-key.mjs";

const PROVIDER_NAME = "command_code";
const MODELS_API_URL = "https://api.commandcode.ai/provider/v1/models";
const PRICING_DOCS_URL = "https://commandcode.ai/docs/resources/pricing-limits";

// Command Code's "Go" tier ($1/mo plan) is restricted to open-source models.
// The live /provider/v1/models endpoint lists every model but carries no
// tier field, so the open-source set is resolved from the RSC payload in
// the pricing docs and intersected with the API by name.
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
  const prefix = 'self.__next_f.push([1,"';
  let searchFrom = 0;

  while (true) {
    const startIdx = html.indexOf(prefix, searchFrom);
    if (startIdx === -1) break;

    const contentStart = startIdx + prefix.length;
    let i = contentStart;
    let payload = "";
    while (i < html.length) {
      if (html[i] === "\\" && i + 1 < html.length) {
        payload += html[i] + html[i + 1];
        i += 2;
      } else if (html.startsWith('"])', i)) {
        break;
      } else {
        payload += html[i];
        i++;
      }
    }

    if (payload.includes("opensource") && payload.includes("models")) {
      const unescaped = payload.replace(/\\"/g, '"');
      const bracketIdx = unescaped.indexOf("[");
      if (bracketIdx === -1) continue;

      const jsonStr = unescaped.slice(bracketIdx);
      // Trim trailing non-JSON content (e.g. trailing \n from RSC payload)
      const cleanJson = jsonStr.replace(/[^}\]]*$/, "");
      try {
        const data = JSON.parse(cleanJson);
        const modelObj = data[3];
        if (!modelObj || !modelObj.models) continue;

        const names = new Set();
        for (const m of modelObj.models) {
          if (m.category === "opensource" && m.name) {
            names.add(m.name);
          }
        }
        return names;
      } catch {
        continue;
      }
    }

    searchFrom = contentStart + payload.length;
  }

  throw new Error("Unable to locate open-source model data in Command Code pricing docs");
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
    const modelKey = uniqueModelKey(map, toModelKey(id), id);
    map.set(modelKey, id);
    providerConfigByModel.set(modelKey, { allowedTiers: [GO_TIER] });
  }

  return {
    modelMap: new Map([...map.entries()].sort(([a], [b]) => a.localeCompare(b))),
    providerConfigByModel,
  };
}

async function main() {
  const { dryRun } = parseFlags();
  const modelsDir = resolveModelsDir(import.meta.url);

  const models = await fetchGoTierModels();
  const { modelMap, providerConfigByModel } = buildModelMap(models);

  const result = syncProviderModels(modelsDir, PROVIDER_NAME, modelMap, {
    providerConfigByModel,
    managedProviderConfigKeys: ["allowedTiers"],
    dryRun,
  });

  logSyncResult({ label: "[command-code] Go-tier", count: modelMap.size, result, would: dryRun });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
