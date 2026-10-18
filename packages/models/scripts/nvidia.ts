import { Effect } from "effect";

import { buildIndex, sync, upstream } from "#models/model-store.ts";
import { fetchDecoded, runOrThrow } from "#models/sync/http.ts";
import { stripParamInfoKey } from "#models/model/clean-key.ts";
import { arrayAt, asTrimmedString, stringAt } from "#models/json.ts";
import { packageModelsDir, runScript } from "./shared.ts";

const PROVIDER_NAME = "nvidia_nim";
const NVIDIA_MODELS_URL = "https://integrate.api.nvidia.com/v1/models";
const NVIDIA_MODEL_DOCS_URLS = [
  "https://docs.api.nvidia.com/nim/reference/llm-apis",
  "https://docs.api.nvidia.com/nim/reference/multimodal-apis",
  "https://docs.api.nvidia.com/nim/reference/visual-models-apis",
];

const EXCLUDED_MODEL_KEY_TOKENS = [
  "detection",
  "embed",
  "embedding",
  "guard",
  "nemoretriever",
  "parse",
  "rerank",
  "retriever",
  "safety",
  "vila",
];

function toModelKey(modelId: string): string {
  const normalizedModelId = modelId.replace(/^library\//, "");

  const slashIndex = normalizedModelId.indexOf("/");
  const baseModelId = slashIndex === -1 ? normalizedModelId : normalizedModelId.slice(slashIndex + 1);

  const normalized = baseModelId
    .replace(/[:/]/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-{2,}/g, "-");

  return stripParamInfoKey(normalized);
}

function normalizeModelIdForMatch(modelId: string): string {
  return modelId
    .replace(/^library\//, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripHtml(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

function isChatCompletionEndpoint(description: string): boolean {
  const normalized = description.toLowerCase();
  const nonChatMarkers = [
    "embedding",
    "classification",
    "classify",
    "detection",
    "generate dna",
    "generation",
    "ranking",
    "rerank",
    "retrieval",
    "search post",
    "status polling",
  ];

  if (nonChatMarkers.some((marker) => normalized.includes(marker))) return false;

  return (
    normalized.includes("chat conversation") ||
    normalized.includes("chat completion") ||
    normalized.includes("create completion") ||
    normalized.includes("request response from the model")
  );
}

function isExcludedModelKey(modelId: string): boolean {
  const normalized = normalizeModelIdForMatch(modelId);
  return EXCLUDED_MODEL_KEY_TOKENS.some((token) => normalized.includes(token));
}

function extractNvidiaGenerativeModelKeys(html: string): Set<string> {
  const articleStart = html.indexOf('data-testid="RDMD"');
  const articleEnd = articleStart === -1 ? -1 : html.indexOf("</article>", articleStart);
  const article =
    articleStart === -1 ? html : html.slice(articleStart, articleEnd === -1 ? undefined : articleEnd);

  const modelKeys = new Set<string>();
  for (const rowMatch of article.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const cells = [...(rowMatch[1] ?? "").matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(
      (match) => match[1] ?? ""
    );
    if (cells.length < 2) continue;

    const modelMatch = cells[0]?.match(/<a\b[^>]*>([\s\S]*?)<\/a>/);
    const endpointMatch = cells[1]?.match(/<a\b[^>]*>([\s\S]*?)<\/a>/);
    if (!modelMatch || !endpointMatch) continue;

    const modelId = stripHtml(modelMatch[1] ?? "").replace(/\s*\/\s*/, "/");
    const endpoint = stripHtml(endpointMatch[1] ?? "");
    if (
      modelId.includes("/") &&
      !isExcludedModelKey(modelId) &&
      isChatCompletionEndpoint(endpoint)
    ) {
      modelKeys.add(normalizeModelIdForMatch(modelId));
    }
  }

  return modelKeys;
}

function buildModelMap(
  modelIds: string[],
  existingKeys: Map<string, string>,
  llmModelKeys: Set<string>
): Map<string, string> {
  const allAvailableModels = [...new Set(modelIds)].sort((a, b) => a.localeCompare(b));
  const availableModelSet = new Set(allAvailableModels);
  const availableModelByKey = new Map<string, string>();
  for (const modelId of allAvailableModels) {
    const modelKey = toModelKey(modelId);
    if (!availableModelByKey.has(modelKey)) availableModelByKey.set(modelKey, modelId);
  }

  const availableLlmModelSet = new Set(
    allAvailableModels.filter((modelId) => llmModelKeys.has(normalizeModelIdForMatch(modelId)))
  );

  const nextMap = new Map<string, string>();

  for (const [modelKey, upstreamModel] of existingKeys.entries()) {
    const resolvedUpstreamModel = availableModelSet.has(upstreamModel)
      ? upstreamModel
      : availableModelByKey.get(modelKey);
    if (!resolvedUpstreamModel) continue;
    nextMap.set(modelKey, resolvedUpstreamModel);
  }

  const mappedValues = new Set(nextMap.values());

  for (const upstreamModel of allAvailableModels) {
    if (mappedValues.has(upstreamModel)) continue;
    if (!availableLlmModelSet.has(upstreamModel)) continue;

    const baseModelKey = toModelKey(upstreamModel);
    let modelKey = baseModelKey;
    let suffix = 2;

    while (nextMap.has(modelKey) && nextMap.get(modelKey) !== upstreamModel) {
      modelKey = `${baseModelKey}-${suffix}`;
      suffix += 1;
    }

    nextMap.set(modelKey, upstreamModel);
    mappedValues.add(upstreamModel);
  }

  return new Map([...nextMap.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function fetchNvidiaGenerativeModelKeys(): Effect.Effect<Set<string>, Error> {
  const pages = Effect.forEach(
    NVIDIA_MODEL_DOCS_URLS,
    (url) =>
      fetchDecoded(url, { label: "Nvidia model docs", headers: { Accept: "text/html" } }, (response) =>
        response.text()
      ),
    { concurrency: NVIDIA_MODEL_DOCS_URLS.length }
  );

  return pages.pipe(
    Effect.flatMap((values) => {
      const modelKeys = new Set(values.flatMap((page) => [...extractNvidiaGenerativeModelKeys(page)]));
      return modelKeys.size === 0
        ? Effect.fail(new Error("Unexpected Nvidia model docs payload format"))
        : Effect.succeed(modelKeys);
    })
  );
}

async function fetchNvidiaModelIds(): Promise<string[]> {
  return runOrThrow(
    fetchDecoded(
      NVIDIA_MODELS_URL,
      { label: "Nvidia NIM models", headers: { Accept: "application/json" } },
      async (response) => {
        const models = arrayAt(await response.json(), "data");
        if (models.length === 0) {
          throw new Error("Unexpected Nvidia /v1/models payload format");
        }
        return models.flatMap((item) => {
          const id = asTrimmedString(stringAt(item, "id"));
          return id ? [id] : [];
        });
      }
    )
  );
}

async function main(): Promise<void> {
  const modelsDir = packageModelsDir();

  const existingKeys = new Map<string, string>();
  for (const [modelId, entry] of Object.entries(buildIndex(modelsDir))) {
    if (!(entry.data.providers ?? []).includes(PROVIDER_NAME)) continue;
    const name = upstream(entry.data, PROVIDER_NAME, modelId);
    if (name) existingKeys.set(entry.id || modelId, name);
  }

  const [modelIds, llmModelKeys] = await Promise.all([
    fetchNvidiaModelIds(),
    runOrThrow(fetchNvidiaGenerativeModelKeys()),
  ]);
  const nextMap = buildModelMap(modelIds, existingKeys, llmModelKeys);

  const result = await sync(modelsDir, PROVIDER_NAME, nextMap);

  if (result.added.length === 0 && result.removed.length === 0 && result.updated.length === 0) {
    console.log(`Nvidia NIM models are already up to date (${nextMap.size} models).`);
  } else {
    console.log(
      `Nvidia NIM: ${nextMap.size} models (added ${result.added.length}, removed ${result.removed.length}, updated ${result.updated.length}).`
    );
  }
}

runScript(main);
