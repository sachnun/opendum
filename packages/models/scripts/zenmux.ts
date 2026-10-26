import { idMap, sync } from "#models/model-store.ts";
import { fetchJson } from "#models/sync/http.ts";
import { stripParams } from "#models/model/clean-key.ts";
import { arrayAt, asRecord, trimmed, stringAt } from "#models/json.ts";
import { dataDir, runScript } from "./shared.ts";

const PROVIDER_NAME = "zenmux";
const ZENMUX_PLANS_URL = "https://zenmux.ai/api/subscription/public/get_all_plans";
const ZENMUX_MODELS_URL = "https://zenmux.ai/api/v1/models";

function modelKey(modelId: string): string {
  const slashIndex = modelId.indexOf("/");
  const baseModelId = slashIndex === -1 ? modelId : modelId.slice(slashIndex + 1);

  const modelKey = baseModelId
    .replace(/[:/]/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-{2,}/g, "-");

  const cleaned = stripParams(modelKey);
  return cleaned.endsWith("-free") ? cleaned.slice(0, -"-free".length) : cleaned;
}

function planSlugs(plans: unknown): Set<string> {
  const freePlan = arrayAt(plans, "data").find((plan) => {
    const description = stringAt(plan, "desc");
    return description !== undefined && description.includes("5 Flows/5h");
  });
  if (!freePlan) {
    throw new Error("Free Plan (5 Flows/5h) not found in ZenMux plans");
  }

  const models = arrayAt(freePlan, "models");
  const slugs = new Set<string>();
  for (const model of models) {
    if (stringAt(model, "provider_slug") !== "*") continue;
    const slug = trimmed(asRecord(model)?.["model_slug"]);
    if (slug) slugs.add(slug);
  }
  if (slugs.size === 0) {
    throw new Error("No models found in ZenMux Free Plan");
  }
  return slugs;
}

async function freeIds(): Promise<string[]> {
  const plans = await fetchJson(ZENMUX_PLANS_URL, { label: "ZenMux subscription plans" });
  if (!Array.isArray(asRecord(plans)?.["data"])) {
    throw new Error("Unexpected ZenMux get_all_plans payload format");
  }
  const allowed = planSlugs(plans);

  const catalog = await fetchJson(ZENMUX_MODELS_URL, { label: "ZenMux /v1/models" });
  const models = arrayAt(catalog, "data");
  if (models.length === 0) {
    throw new Error("Unexpected ZenMux /v1/models payload format");
  }

  const ids: string[] = [];
  for (const model of models) {
    const id = trimmed(stringAt(model, "id"));
    if (!id || !allowed.has(id)) continue;

    const outputModalities = asRecord(model)?.["output_modalities"];
    if (Array.isArray(outputModalities) && outputModalities.length > 0 && !outputModalities.includes("text")) {
      continue;
    }
    ids.push(id);
  }

  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

async function main(): Promise<void> {
  const modelsDir = dataDir();

  const modelIds = await freeIds();
  const modelMap = idMap(modelIds, modelKey);

  const result = await sync(modelsDir, PROVIDER_NAME, modelMap, {
    providerConfig: new Map(modelIds.map((id) => [modelKey(id), {}])),
  });

  if (result.added.length === 0 && result.removed.length === 0 && result.updated.length === 0) {
    console.log(`ZenMux free plan models are already up to date (${modelMap.size} models).`);
  } else {
    console.log(
      `ZenMux: ${modelMap.size} models (added ${result.added.length}, removed ${result.removed.length}, updated ${result.updated.length}).`
    );
  }
}

runScript(main);
