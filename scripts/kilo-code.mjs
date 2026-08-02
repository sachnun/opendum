#!/usr/bin/env node

import { buildModelIndex, syncProviderModels, writeModelJson } from "./model-registry.mjs";
import { fetchJson, parseFlags, resolveModelsDir, logSyncResult, uniqueModelKey } from "./lib/shared.mjs";
import { stripParamInfoKey } from "./lib/clean-key.mjs";

const KILO_CODE_MODELS_URL = "https://api.kilo.ai/api/gateway/models";

const MODEL_KEY_OVERRIDES = new Map([
  ["x-ai/grok-code-fast-1:optimized:free", "grok-code-fast-1"],
]);

function toModelKey(modelId) {
  const override = MODEL_KEY_OVERRIDES.get(modelId);
  if (override) return override;

  // kilo-auto/* models: replace / with -
  if (modelId.startsWith("kilo-auto/")) {
    return stripParamInfoKey(modelId.replace("/", "-"));
  }

  // Strip provider prefix (e.g. "minimax/minimax-m2.5:free" → "minimax-m2.5:free")
  const withoutProvider = modelId.includes("/")
    ? modelId.slice(modelId.indexOf("/") + 1)
    : modelId;

  // Remove :free suffix for the key (but keep full ID as upstream)
  const modelKey = withoutProvider
    .replace(/:free$/, "")
    .replace(/[:/]/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-{2,}/g, "-");

  return stripParamInfoKey(modelKey);
}

function isEligibleModel(model) {
  if (!model || typeof model !== "object") return false;

  const id = typeof model.id === "string" ? model.id.trim() : "";
  if (!id) return false;

  return model.isFree === true;
}

function buildModelMap(models) {
  const map = new Map();

  for (const model of models) {
    const modelId = model.id.trim();
    const modelKey = uniqueModelKey(map, toModelKey(modelId), modelId);
    map.set(modelKey, modelId);
  }

  return new Map([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

async function fetchKiloCodeModels() {
  const payload = await fetchJson(KILO_CODE_MODELS_URL, { label: "Kilo Code gateway models" });
  if (!payload || !Array.isArray(payload.data)) {
    throw new Error("Unexpected Kilo Gateway /models payload format");
  }
  return payload.data.filter((item) => isEligibleModel(item));
}

async function main() {
  const { dryRun } = parseFlags();
  const modelsDir = resolveModelsDir(import.meta.url);

  const models = await fetchKiloCodeModels();
  const modelMap = buildModelMap(models);

  const result = syncProviderModels(modelsDir, "kilo_code", modelMap, { dryRun });
  const metadataUpdates = dryRun ? 0 : applyAuthlessMetadata(modelsDir, modelMap);

  logSyncResult({
    label: "[kilo-code] free",
    count: modelMap.size,
    result,
    would: dryRun,
    extra: `metadata ${metadataUpdates}`,
  });
}

function applyAuthlessMetadata(modelsDir, modelMap) {
  const index = buildModelIndex(modelsDir);
  let updated = 0;

  for (const entry of Object.values(index)) {
    if (!entry.data.providers?.includes("kilo_code")) continue;
    if (!entry.data.providerConfig?.kilo_code) continue;

    if (entry.data.providerConfig.kilo_code.authless !== true) {
      entry.data.providerConfig.kilo_code.authless = true;
      writeModelJson(entry.path, entry.data);
      updated += 1;
    }
  }

  return updated;
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
