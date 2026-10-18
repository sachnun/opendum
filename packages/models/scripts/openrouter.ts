import { idMap, sync } from "#models/model-store.ts";
import { fetchDecoded, runOrThrow } from "#models/sync/http.ts";
import { stripParamInfoKey } from "#models/model/clean-key.ts";
import { arrayAt, asRecord, asTrimmedString, stringAt } from "#models/json.ts";
import { packageModelsDir, runScript } from "./shared.ts";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

function toModelKey(modelId: string): string {
  const normalizedModelId = modelId.replace(/^library\//, "");
  const providerStrippedModelId =
    normalizedModelId === "openrouter/free"
      ? normalizedModelId
      : normalizedModelId.includes("/")
        ? normalizedModelId.slice(normalizedModelId.indexOf("/") + 1)
        : normalizedModelId;

  const modelKey = providerStrippedModelId
    .replace(/[:/]/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-{2,}/g, "-");

  const cleaned = stripParamInfoKey(modelKey);
  if (modelKey !== "openrouter-free" && cleaned.endsWith("-free")) {
    return cleaned.slice(0, -"-free".length);
  }

  return cleaned;
}

function isFreeChatModel(model: unknown): boolean {
  const id = asTrimmedString(stringAt(model, "id"));
  if (!id) return false;

  const isFreeModelId = id === "openrouter/free" || id.endsWith(":free");
  if (!isFreeModelId) return false;

  const architecture = asRecord(asRecord(model)?.["architecture"]);
  const inputModalities = arrayAt(architecture, "input_modalities");
  const outputModalities = arrayAt(architecture, "output_modalities");
  const supportsTextInput = inputModalities.length === 0 || inputModalities.includes("text");
  const supportsTextOutput = outputModalities.length === 0 || outputModalities.includes("text");
  if (!supportsTextInput || !supportsTextOutput) return false;

  const supportedParameters = arrayAt(model, "supported_parameters");
  return (
    supportedParameters.length === 0 ||
    supportedParameters.includes("max_tokens") ||
    supportedParameters.includes("temperature") ||
    supportedParameters.includes("tools")
  );
}

function freeModelIds(payload: unknown): string[] {
  const data = arrayAt(payload, "data");
  if (data.length === 0) {
    throw new Error("Unexpected OpenRouter /v1/models payload format");
  }

  const ids: string[] = [];
  for (const model of data) {
    if (!isFreeChatModel(model)) continue;
    const id = asTrimmedString(stringAt(model, "id"));
    if (id) ids.push(id);
  }
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

async function fetchOpenRouterFreeModelIds(): Promise<string[]> {
  return runOrThrow(
    fetchDecoded(
      OPENROUTER_MODELS_URL,
      { label: "OpenRouter free models", headers: { Accept: "application/json" } },
      async (response) => freeModelIds(await response.json())
    )
  );
}

async function main(): Promise<void> {
  const modelsDir = packageModelsDir();

  const modelIds = await fetchOpenRouterFreeModelIds();
  const modelMap = idMap(modelIds, toModelKey);

  const result = await sync(modelsDir, "openrouter", modelMap);

  if (result.added.length === 0 && result.removed.length === 0 && result.updated.length === 0) {
    console.log(`OpenRouter free models are already up to date (${modelMap.size} models).`);
  } else {
    console.log(
      `OpenRouter: ${modelMap.size} models (added ${result.added.length}, removed ${result.removed.length}, updated ${result.updated.length}).`
    );
  }
}

runScript(main);
