import { buildIndex, persist, sync } from "#models/model-store.ts";
import { fetchJson } from "#models/sync/http.ts";
import { stripParams } from "#models/model/clean-key.ts";
import { arrayAt, asRecord, trimmed, stringAt } from "#models/json.ts";
import { dataDir, runScript } from "./shared.ts";
import type { ModelData, ModelIndexEntry } from "#models/types.ts";

const PROVIDER_NAME = "hyper";
const HYPER_MODELS_URL = "https://hyper.charm.land/v1/models";

const MIN_EXPECTED_MODELS = 10;

interface HyperModel {
  id: string;
  reasoning: boolean;
}

function keyOf(modelId: string): string {
  const normalized = modelId
    .replace(/[:/]/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-{2,}/g, "-");

  return stripParams(normalized);
}

function fullKey(modelId: string): string {
  return modelId
    .replace(/[:/]/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-{2,}/g, "-");
}

function modelIndex(models: HyperModel[]): Map<string, string> {
  const map = new Map<string, string>();

  for (const model of models) {
    const baseModelKey = keyOf(model.id);
    let modelKey = baseModelKey;
    let suffix = 2;

    while (map.has(modelKey) && map.get(modelKey) !== model.id) {
      modelKey = suffix === 2 ? fullKey(model.id) : `${fullKey(model.id)}-${suffix}`;
      suffix += 1;
    }

    map.set(modelKey, model.id);
  }

  return new Map([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function enrichModels(
  modelsDir: string,
  addedKeys: string[],
  modelMap: Map<string, string>,
  metadataLookup: Map<string, HyperModel>
): void {
  const index = buildIndex(modelsDir);

  for (const modelKey of addedKeys) {
    const entry = Object.values(index).find(
      (item) => item.fileId === modelKey || item.id === modelKey
    );
    if (!entry) continue;

    const upstreamName = modelMap.get(modelKey);
    const model = upstreamName ? metadataLookup.get(upstreamName) : undefined;
    if (!model || !model.reasoning) continue;

    const data: ModelData = entry.data;
    if (data.reasoning === true) continue;
    data.reasoning = true;
    persist(entry as ModelIndexEntry, data);
  }
}

function toModels(payload: unknown): HyperModel[] {
  const data = arrayAt(payload, "data");
  if (data.length === 0) {
    throw new Error("Unexpected Hyper /v1/models payload format");
  }

  const models: HyperModel[] = [];
  for (const item of data) {
    const id = trimmed(stringAt(item, "id"));
    if (!id) continue;
    const effortLevels = arrayAt(asRecord(asRecord(item)?.["reasoning"]), "effort_levels");
    models.push({ id, reasoning: effortLevels.length > 0 });
  }
  if (models.length === 0) {
    throw new Error("Hyper /v1/models returned no models");
  }
  if (models.length < MIN_EXPECTED_MODELS) {
    console.warn(
      `Hyper /v1/models returned only ${models.length} models (expected >= ${MIN_EXPECTED_MODELS})`
    );
  }
  return models;
}

async function fetchModels(): Promise<HyperModel[]> {
  const payload = await fetchJson(HYPER_MODELS_URL, { label: "Hyper /v1/models" });
  return toModels(payload);
}

async function main(): Promise<void> {
  const modelsDir = dataDir();

  const models = await fetchModels();
  const modelMap = modelIndex(models);
  const metadataLookup = new Map(models.map((model) => [model.id, model]));

  const result = await sync(modelsDir, PROVIDER_NAME, modelMap);

  if (result.added.length > 0) {
    enrichModels(modelsDir, result.added, modelMap, metadataLookup);
  }

  if (result.added.length === 0 && result.removed.length === 0 && result.updated.length === 0) {
    console.log(`Hyper models are already up to date (${modelMap.size} models).`);
  } else {
    console.log(
      `Hyper: ${modelMap.size} models (added ${result.added.length}, removed ${result.removed.length}, updated ${result.updated.length}).`
    );
  }
}

runScript(main);
