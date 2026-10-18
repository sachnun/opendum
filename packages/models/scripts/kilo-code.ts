import { idMap, sync } from "#models/model-store.ts";
import { fetchDecoded, runOrThrow } from "#models/sync/http.ts";
import { stripParamInfoKey } from "#models/model/clean-key.ts";
import { arrayAt, asTrimmedString, booleanAt, stringAt } from "#models/json.ts";
import { packageModelsDir, runScript } from "./shared.ts";

const KILO_CODE_MODELS_URL = "https://api.kilo.ai/api/gateway/models";

function toModelKey(modelId: string): string {
  if (modelId.startsWith("kilo-auto/")) {
    return stripParamInfoKey(modelId.replace("/", "-"));
  }

  const withoutProvider = modelId.includes("/")
    ? modelId.slice(modelId.indexOf("/") + 1)
    : modelId;

  const withoutParams = withoutProvider.replace(/(?::[a-zA-Z0-9_-]+)+$/, "");

  const modelKey = withoutParams
    .replace(/[:/]/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-{2,}/g, "-");

  return stripParamInfoKey(modelKey);
}

function freeModelIds(payload: unknown): string[] {
  const data = arrayAt(payload, "data");
  if (data.length === 0) {
    throw new Error("Unexpected Kilo Gateway /models payload format");
  }

  const ids: string[] = [];
  for (const model of data) {
    if (booleanAt(model, "isFree") !== true) continue;
    const id = asTrimmedString(stringAt(model, "id"));
    if (id) ids.push(id);
  }
  return ids;
}

async function fetchKiloCodeModelIds(): Promise<string[]> {
  return runOrThrow(
    fetchDecoded(
      KILO_CODE_MODELS_URL,
      { label: "Kilo Code models", headers: { Accept: "application/json" } },
      async (response) => freeModelIds(await response.json())
    )
  );
}

async function main(): Promise<void> {
  const modelsDir = packageModelsDir();

  const modelIds = await fetchKiloCodeModelIds();
  const modelMap = idMap(modelIds, toModelKey);
  const providerConfigByModel = new Map(
    [...modelMap.keys()].map((modelKey) => [modelKey, { authless: true, free: true }])
  );

  const result = await sync(modelsDir, "kilo_code", modelMap, {
    providerConfigByModel,
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
