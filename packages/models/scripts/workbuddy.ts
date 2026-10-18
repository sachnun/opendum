import { buildIndex, persist, sync } from "#models/model-store.ts";
import { arrayAt, asTrimmedString, booleanAt, stringAt } from "#models/json.ts";
import { exists, readText } from "#models/fs.ts";
import { join } from "#models/paths.ts";
import { env, fetchPackageJson, packageModelsDir, runScript } from "./shared.ts";
import type { ModelData, ModelIndexEntry } from "#models/types.ts";

const PROVIDER_NAME = "workbuddy";
const WORKBUDDY_NPM_PACKAGE = "@tencent-ai/codebuddy-code";

const WORKBUDDY_PRODUCT_FILE = "product.json";

const MIN_EXPECTED_MODELS = 20;

const HOUSE_MODEL_PATTERN = /(?:^|-)model$/;

interface CatalogEntry {
  id: string;
  reasoning: boolean;
}

function isExcludedId(id: string): boolean {
  if (id.includes("image")) return true;
  if (id.startsWith("hunyuan-video")) return true;
  return false;
}

function toCatalogEntry(value: unknown): CatalogEntry | null {
  const id = asTrimmedString(stringAt(value, "id"));
  if (!id || isExcludedId(id)) return null;
  return { id, reasoning: booleanAt(value, "supportsReasoning") === true };
}

async function fetchWorkbuddyCatalog(): Promise<CatalogEntry[]> {
  const { version, payload } = await fetchPackageJson(
    WORKBUDDY_NPM_PACKAGE,
    WORKBUDDY_PRODUCT_FILE,
    { label: `${WORKBUDDY_NPM_PACKAGE} product catalog` }
  );

  const models = arrayAt(payload, "models");
  if (models.length === 0) {
    throw new Error(`Unexpected models payload in ${WORKBUDDY_NPM_PACKAGE}@${version}`);
  }
  return models.flatMap((item) => {
    const entry = toCatalogEntry(item);
    return entry ? [entry] : [];
  });
}

function readLocalCatalog(): CatalogEntry[] {
  const home = env("HOME");
  if (!home) return [];

  const candidate = join(home, ".workbuddy-ai", "cache", "acc-product-config-v3.json");
  if (!exists(candidate)) return [];

  try {
    const payload: unknown = JSON.parse(readText(candidate));
    const models = Array.isArray(payload) ? payload : arrayAt(payload, "models");
    return models.flatMap((item) => {
      const entry = toCatalogEntry(item);
      return entry ? [entry] : [];
    });
  } catch {
    return [];
  }
}

function buildModelMap(catalog: CatalogEntry[]): {
  modelMap: Map<string, string>;
  metadataLookup: Map<string, CatalogEntry>;
} {
  const modelMap = new Map<string, string>();
  const metadataLookup = new Map<string, CatalogEntry>();

  const register = (entry: CatalogEntry): void => {
    if (modelMap.has(entry.id)) return;
    modelMap.set(entry.id, entry.id);
    metadataLookup.set(entry.id, entry);
  };

  for (const entry of catalog) register(entry);
  for (const entry of readLocalCatalog()) register(entry);

  if (modelMap.size === 0) {
    throw new Error("WorkBuddy catalog produced no models");
  }
  if (modelMap.size < MIN_EXPECTED_MODELS) {
    console.warn(
      `WorkBuddy catalog produced ${modelMap.size} models (expected >= ${MIN_EXPECTED_MODELS})`
    );
  }

  return {
    modelMap: new Map([...modelMap.entries()].sort(([a], [b]) => a.localeCompare(b))),
    metadataLookup,
  };
}

function enrichNewModels(
  modelsDir: string,
  addedKeys: string[],
  modelMap: Map<string, string>,
  metadataLookup: Map<string, CatalogEntry>
): void {
  const index = buildIndex(modelsDir);

  for (const modelKey of addedKeys) {
    const entry = Object.values(index).find(
      (item) => item.fileId === modelKey || item.id === modelKey
    );
    if (!entry) continue;

    const upstreamName = modelMap.get(modelKey);
    const catalogEntry = upstreamName ? metadataLookup.get(upstreamName) : undefined;
    if (!catalogEntry) continue;

    const data: ModelData = entry.data;
    data.reasoning = catalogEntry.reasoning;
    persist(entry as ModelIndexEntry, data);
  }
}

function enforceHouseIgnored(modelsDir: string): string[] {
  const index = buildIndex(modelsDir);
  const changed: string[] = [];

  for (const entry of Object.values(index)) {
    const modelKey = entry.id || entry.fileId;
    if (!modelKey || !HOUSE_MODEL_PATTERN.test(modelKey)) continue;
    if (entry.data.ignored === true) continue;

    const providers = entry.data.providers ?? [];
    if (providers.length > 0 && !providers.every((provider) => provider === PROVIDER_NAME)) continue;

    entry.data.ignored = true;
    persist(entry, entry.data);
    changed.push(modelKey);
  }

  return changed;
}

async function main(): Promise<void> {
  const modelsDir = packageModelsDir();

  const catalog = await fetchWorkbuddyCatalog();
  const { modelMap, metadataLookup } = buildModelMap(catalog);

  const result = await sync(modelsDir, PROVIDER_NAME, modelMap);
  const ignored = enforceHouseIgnored(modelsDir);

  if (result.added.length > 0) {
    enrichNewModels(modelsDir, result.added, modelMap, metadataLookup);
  }

  if (
    result.added.length === 0 &&
    result.removed.length === 0 &&
    result.updated.length === 0 &&
    ignored.length === 0
  ) {
    console.log(`WorkBuddy models are already up to date (${modelMap.size} models).`);
  } else {
    console.log(
      `WorkBuddy: ${modelMap.size} models (added ${result.added.length}, removed ${result.removed.length}, updated ${result.updated.length}, disabled ${ignored.length}).`
    );
  }
}

runScript(main);
