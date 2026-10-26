import { idMap, sync } from "#models/model-store.ts";
import { fetchDecoded, orThrow } from "#models/sync/http.ts";
import { stripParams } from "#models/model/clean-key.ts";
import { arrayAt, trimmed, booleanAt, stringAt } from "#models/json.ts";
import { dataDir, runScript } from "./shared.ts";

const MODELS_URL = "https://api.kilo.ai/api/gateway/models";

function modelKey(modelId: string): string {
  if (modelId.startsWith("kilo-auto/")) {
    return stripParams(modelId.replace("/", "-"));
  }

  const withoutProvider = modelId.includes("/")
    ? modelId.slice(modelId.indexOf("/") + 1)
    : modelId;

  const withoutParams = withoutProvider.replace(/(?::[a-zA-Z0-9_-]+)+$/, "");

  const modelKey = withoutParams
    .replace(/[:/]/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-{2,}/g, "-");

  return stripParams(modelKey);
}

function freeModels(payload: unknown): string[] {
  const data = arrayAt(payload, "data");
  if (data.length === 0) {
    throw new Error("Unexpected Kilo Gateway /models payload format");
  }

  const ids: string[] = [];
  for (const model of data) {
    if (booleanAt(model, "isFree") !== true) continue;
    const id = trimmed(stringAt(model, "id"));
    if (id) ids.push(id);
  }
  return ids;
}

async function idsFrom(): Promise<string[]> {
  return orThrow(
    fetchDecoded(
      MODELS_URL,
      { label: "Kilo Code models", headers: { Accept: "application/json" } },
      async (response) => freeModels(await response.json())
    )
  );
}

async function main(): Promise<void> {
  const modelsDir = dataDir();

  const modelIds = await idsFrom();
  const modelMap = idMap(modelIds, modelKey);
  const providerConfig = new Map(
    [...modelMap.keys()].map((modelKey) => [modelKey, { authless: true, free: true }])
  );

  const result = await sync(modelsDir, "kilo_code", modelMap, {
    providerConfig,
    managedProviderConfigKeys: ["authless", "free"],
  });

  if (result.added.length === 0 && result.removed.length === 0 && result.updated.length === 0) {
    console.log(`Kilo Code models are already up to date (${modelMap.size} models).`);
  } else {
    console.log(
      `Kilo Code: ${modelMap.size} free models (added ${result.added.length}, removed ${result.removed.length}, updated ${result.updated.length}).`
    );
  }
}

runScript(main);
