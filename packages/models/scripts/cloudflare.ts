import { buildIndex, upstream, sync, persist } from "#models/model-store.ts";
import { runFetchJson } from "#models/sync/http.ts";
import { stripParams } from "#models/model/clean-key.ts";
import { arrayAt, asRecord, trimmed, recordAt, stringAt } from "#models/json.ts";
import { env, dataDir, runScript } from "./shared.ts";
import type { ModelData, ModelIndexEntry, ModelModalities } from "#models/types.ts";

const PROVIDER_NAME = "workers_ai";
const MODELS_API_URL =
  "https://api.github.com/repos/cloudflare/cloudflare-docs/contents/src/content/workers-ai-models?ref=production";
const FETCH_CONCURRENCY = 8;

const EXCLUDED_TOKENS = ["guard"];

interface ModelFile {
  slug: string;
  downloadUrl: string;
}

interface WorkersAIModel {
  slug: string;
  model: unknown;
}

interface ModelMetadata {
  family: string | undefined;
  reasoning: boolean;
  modalities: ModelModalities;
}

function apiHeaders(): Record<string, string> {
  const token = env("GITHUB_TOKEN") ?? env("GH_TOKEN");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function getProperty(model: unknown, propertyId: string): unknown {
  const properties = arrayAt(model, "properties");
  const property = properties.find((item) => stringAt(item, "property_id") === propertyId);
  return asRecord(property)?.["value"];
}

function isTrue(value: unknown): boolean {
  return value === true || value === "true";
}

function supportsMessages(value: unknown, depth = 0): boolean {
  if (depth > 64 || value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.some((item) => supportsMessages(item, depth + 1));
  const record = asRecord(value);
  if (!record) return false;

  const properties = asRecord(record["properties"]);
  if (properties?.["messages"]) return true;
  return Object.values(record).some((item) => supportsMessages(item, depth + 1));
}

function normalizeKey(value: string): string {
  return stripParams(
    value
      .replace(/^@[^/]+\//, "")
      .replace(/[:/]/g, "-")
      .replace(/[^a-zA-Z0-9._-]/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^-+|-+$/g, "")
  );
}

function keyOf(model: unknown, slug: string, reverseMap: Map<string, string>): string {
  const upstreamName = trimmed(stringAt(model, "name")) ?? "";
  const existing = reverseMap.get(upstreamName);
  if (existing) return existing;
  if (slug) return normalizeKey(slug);

  const lastSlash = upstreamName.lastIndexOf("/");
  return normalizeKey(lastSlash === -1 ? upstreamName : upstreamName.slice(lastSlash + 1));
}

function deriveFamily(modelKey: string): string | undefined {
  if (/^kimi-/i.test(modelKey)) return "Moonshot";
  if (/^glm-/i.test(modelKey)) return "Z.AI";
  if (/^gpt-|^o\d/i.test(modelKey)) return "OpenAI";
  if (/^gemma/i.test(modelKey)) return "Gemini";
  if (/^llama|^meta-llama/i.test(modelKey)) return "Meta";
  if (/^qwen|^qwq-/i.test(modelKey)) return "Qwen";
  if (/^deepseek-/i.test(modelKey)) return "DeepSeek";
  if (/^mistral-|^mixtral|^codestral|^devstral|^ministral|^mamba-codestral|^magistral/i.test(modelKey)) return "Mistral";
  if (/^nemotron-/i.test(modelKey)) return "NVIDIA";
  if (/^granite-/i.test(modelKey)) return "IBM";
  if (/^phi-/i.test(modelKey)) return "Microsoft";
  return undefined;
}

function buildCapabilities(model: unknown): { reasoning: boolean; modalities: ModelModalities } {
  const vision = isTrue(getProperty(model, "vision"));
  return {
    reasoning: isTrue(getProperty(model, "reasoning")),
    modalities: { input: vision ? ["text", "image"] : ["text"], output: ["text"] },
  };
}

function reverseIndex(modelsDir: string): Map<string, string> {
  const reverseMap = new Map<string, string>();

  for (const [modelId, entry] of Object.entries(buildIndex(modelsDir))) {
    if (!(entry.data.providers ?? []).includes(PROVIDER_NAME)) continue;
    const name = upstream(entry.data, PROVIDER_NAME, modelId);
    if (name) reverseMap.set(name, entry.id || modelId);
  }

  return reverseMap;
}

function isIgnored(
  index: Record<string, ModelIndexEntry>,
  modelKey: string
): boolean {
  const entry = Object.values(index).find(
    (item) => item.fileId === modelKey || item.id === modelKey
  );
  if (!entry?.data.ignored) return false;
  return !(entry.data.providers ?? []).includes(PROVIDER_NAME);
}

function shouldInclude(
  model: unknown,
  modelKey: string,
  index: Record<string, ModelIndexEntry>,
  existingWorkersAI: boolean
): boolean {
  const name = trimmed(stringAt(model, "name"));
  if (!name || !name.startsWith("@")) return false;
  if (stringAt(recordAt(model, "task"), "name") !== "Text Generation") return false;
  if (!supportsMessages(recordAt(recordAt(model, "schema"), "input"))) return false;
  if (isTrue(getProperty(model, "lora"))) return false;
  if (isTrue(getProperty(model, "require_workers_paid"))) return false;
  if (getProperty(model, "planned_deprecation_date") && !existingWorkersAI) return false;
  if (isIgnored(index, modelKey)) return false;

  const normalized = modelKey.toLowerCase();
  return !EXCLUDED_TOKENS.some((token) => normalized.includes(token));
}

function modelIndex(
  models: WorkersAIModel[],
  modelsDir: string,
  reverseMap: Map<string, string>
): { modelMap: Map<string, string>; metadata: Map<string, ModelMetadata> } {
  const index = buildIndex(modelsDir);
  const map = new Map<string, string>();
  const metadata = new Map<string, ModelMetadata>();

  for (const item of models) {
    const upstreamName = trimmed(stringAt(item.model, "name")) ?? "";
    const existingWorkersAI = reverseMap.has(upstreamName);
    const modelKey = keyOf(item.model, item.slug, reverseMap);
    if (!modelKey || !shouldInclude(item.model, modelKey, index, existingWorkersAI)) continue;

    map.set(modelKey, upstreamName);
    const capabilities = buildCapabilities(item.model);
    metadata.set(modelKey, {
      family: deriveFamily(modelKey),
      reasoning: capabilities.reasoning,
      modalities: capabilities.modalities,
    });
  }

  return {
    modelMap: new Map([...map.entries()].sort(([a], [b]) => a.localeCompare(b))),
    metadata,
  };
}

function applyMetadata(modelsDir: string, metadata: Map<string, ModelMetadata>): number {
  const index = buildIndex(modelsDir);
  let updated = 0;

  for (const [modelKey, info] of metadata.entries()) {
    const entry = Object.values(index).find(
      (item) => item.fileId === modelKey || item.id === modelKey
    );
    if (!entry) continue;

    const data: ModelData = entry.data;
    let changed = false;

    if (info.reasoning !== undefined && data.reasoning === undefined) {
      data.reasoning = info.reasoning;
      changed = true;
    }
    if (info.modalities !== undefined && data.modalities === undefined) {
      data.modalities = info.modalities;
      changed = true;
    }

    if (changed) {
      persist(entry, data);
      updated += 1;
    }
  }

  return updated;
}

function modelFiles(payload: unknown): ModelFile[] {
  if (!Array.isArray(payload)) {
    throw new Error("Unexpected Cloudflare Workers AI model file list payload");
  }

  return payload
    .flatMap((file) => {
      if (stringAt(file, "type") !== "file") return [];
      const name = trimmed(stringAt(file, "name"));
      const downloadUrl = trimmed(stringAt(file, "download_url"));
      if (!name || !name.endsWith(".json") || !downloadUrl) return [];
      return [{ slug: name.replace(/\.json$/, ""), downloadUrl }];
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

async function fetchModels(): Promise<WorkersAIModel[]> {
  const payload = await runFetchJson(MODELS_API_URL, { headers: apiHeaders() });
  const files = modelFiles(payload);

  const models: WorkersAIModel[] = [];
  for (let index = 0; index < files.length; index += FETCH_CONCURRENCY) {
    const batch = files.slice(index, index + FETCH_CONCURRENCY);
    const resolved = await Promise.all(
      batch.map(async (file) => ({
        slug: file.slug,
        model: await runFetchJson(file.downloadUrl, { label: `Workers AI model ${file.slug}` }),
      }))
    );
    models.push(...resolved);
  }

  return models;
}

async function main(): Promise<void> {
  const modelsDir = dataDir();
  const reverseMap = reverseIndex(modelsDir);

  const models = await fetchModels();
  const { modelMap, metadata } = modelIndex(models, modelsDir, reverseMap);

  const result = await sync(modelsDir, PROVIDER_NAME, modelMap);
  const metadataUpdates = applyMetadata(modelsDir, metadata);

  if (
    result.added.length === 0 &&
    result.removed.length === 0 &&
    result.updated.length === 0 &&
    metadataUpdates === 0
  ) {
    console.log(`Cloudflare models are already up to date (${modelMap.size} models).`);
    return;
  }

  console.log(
    `Cloudflare: ${modelMap.size} models (added ${result.added.length}, removed ${result.removed.length}, updated ${result.updated.length}, metadata ${metadataUpdates}).`
  );
  if (result.added.length > 0) console.log(`  Added: ${result.added.join(", ")}`);
  if (result.removed.length > 0) console.log(`  Removed: ${result.removed.join(", ")}`);
  if (result.updated.length > 0) console.log(`  Updated: ${result.updated.join(", ")}`);
}

runScript(main);
