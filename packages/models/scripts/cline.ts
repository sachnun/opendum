import { idMap, sync } from "#models/model-store.ts";
import { runFetchJson } from "#models/sync/http.ts";
import { stripParamInfoKey } from "#models/model/clean-key.ts";
import { arrayAt, idsOf } from "#models/json.ts";
import { packageModelsDir, runScript } from "./shared.ts";

const PROVIDER_NAME = "cline";

const CLINE_RECOMMENDED_MODELS_URL =
  "https://api.cline.bot/api/v1/ai/cline/recommended-models";

const MIN_EXPECTED_MODELS = 1;

function toModelKey(modelId: string): string {
  const slashIndex = modelId.indexOf("/");
  const baseModelId = slashIndex === -1 ? modelId : modelId.slice(slashIndex + 1);

  const modelKey = baseModelId
    .replace(/[:/]/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-{2,}/g, "-");

  const cleaned = stripParamInfoKey(modelKey);
  return cleaned.endsWith("-free") ? cleaned.slice(0, -"-free".length) : cleaned;
}

async function fetchClineFreeModelIds(): Promise<string[]> {
  const payload = await runFetchJson(CLINE_RECOMMENDED_MODELS_URL, {
    label: "Cline recommended models",
  });
  const free = arrayAt(payload, "free");
  if (free.length === 0) {
    throw new Error("Unexpected Cline recommended-models payload format");
  }

  const ids = idsOf(free);
  if (ids.length < MIN_EXPECTED_MODELS) {
    throw new Error(`Expected at least ${MIN_EXPECTED_MODELS} Cline free model(s), got ${ids.length}`);
  }
  return ids;
}

async function main(): Promise<void> {
  const modelsDir = packageModelsDir();

  const modelIds = await fetchClineFreeModelIds();
  const modelMap = idMap(modelIds, toModelKey);

  const result = await sync(modelsDir, PROVIDER_NAME, modelMap);

  if (result.added.length === 0 && result.removed.length === 0 && result.updated.length === 0) {
    console.log(`Cline free models are already up to date (${modelMap.size} models).`);
  } else {
    console.log(
      `Cline: ${modelMap.size} free models (added ${result.added.length}, removed ${result.removed.length}, updated ${result.updated.length}).`
    );
  }
}

runScript(main);
