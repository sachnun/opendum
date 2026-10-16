#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { idMap, sync } from "#models/model-store.ts";
import { fetchDecoded, runOrThrow } from "#models/sync/http.ts";
import { stripParamInfoKey } from "#models/model/clean-key.ts";

const KILO_CODE_MODELS_URL = "https://api.kilo.ai/api/gateway/models";

function toModelKey(modelId) {
  if (modelId.startsWith("kilo-auto/")) {
    return stripParamInfoKey(modelId.replace("/", "-"));
  }

  // Strip provider prefix (e.g. "minimax/minimax-m2.5:free" → "minimax-m2.5:free")
  const withoutProvider = modelId.includes("/")
    ? modelId.slice(modelId.indexOf("/") + 1)
    : modelId;

  // Drop any trailing parameter suffixes (e.g. ":free", ":optimized:free").
  const withoutParams = withoutProvider.replace(/(?::[a-zA-Z0-9_-]+)+$/, "");

  const modelKey = withoutParams
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
  return idMap(models.map((model) => model.id.trim()), toModelKey);
}

async function fetchKiloCodeModels() {
  return runOrThrow(
    fetchDecoded(
      KILO_CODE_MODELS_URL,
      { label: "Kilo Code models", headers: { Accept: "application/json" } },
      async (response) => {
        const payload = await response.json();
        if (!payload || !Array.isArray(payload.data)) {
          throw new Error("Unexpected Kilo Gateway /models payload format");
        }

        return payload.data.filter((item) => isEligibleModel(item));
      }
    )
  );
}

async function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const modelsDir = resolve(scriptDir, "../data");

  const models = await fetchKiloCodeModels();
  const modelMap = buildModelMap(models);
  const providerConfigByModel = new Map(
    [...modelMap.keys()].map((modelKey) => [modelKey, { authless: true, free: true }])
  );

  const result = sync(modelsDir, "kilo_code", modelMap, {
    providerConfigByModel,
    managedProviderConfigKeys: ["authless", "free"],
  });

  if (result.added.length === 0 && result.removed.length === 0 && result.updated.length === 0) {
    console.log(`Kilo Code models are already up to date (${modelMap.size} models).`);
  } else {
    console.log(`Kilo Code: ${modelMap.size} free models (added ${result.added.length}, removed ${result.removed.length}, updated ${result.updated.length}).`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
