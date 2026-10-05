import { stripParamInfoKey } from "#models/model/clean-key.ts";

export const EXCLUDED_MODEL_KEY_TOKENS = [
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

export function toModelKey(modelId) {
  const normalizedModelId = modelId.replace(/^library\//, "");

  const slashIndex = normalizedModelId.indexOf("/");
  const baseModelId = slashIndex === -1
    ? normalizedModelId
    : normalizedModelId.slice(slashIndex + 1);

  const normalized = baseModelId
    .replace(/[:/]/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-{2,}/g, "-");

  return stripParamInfoKey(normalized);
}

export function normalizeModelIdForMatch(modelId) {
  return modelId
    .replace(/^library\//, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripHtml(value) {
  return decodeHtmlEntities(value.replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

function isChatCompletionEndpoint(description) {
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

  if (nonChatMarkers.some((marker) => normalized.includes(marker))) {
    return false;
  }

  return normalized.includes("chat conversation") ||
    normalized.includes("chat completion") ||
    normalized.includes("create completion") ||
    normalized.includes("request response from the model");
}

export function isExcludedModelKey(modelId) {
  const normalized = normalizeModelIdForMatch(modelId);
  return EXCLUDED_MODEL_KEY_TOKENS.some((token) => normalized.includes(token));
}

export function extractNvidiaGenerativeModelKeys(html) {
  const articleStart = html.indexOf('data-testid="RDMD"');
  const articleEnd = articleStart === -1 ? -1 : html.indexOf("</article>", articleStart);
  const article = articleStart === -1
    ? html
    : html.slice(articleStart, articleEnd === -1 ? undefined : articleEnd);
  const modelKeys = new Set();
  const rowPattern = /<tr>([\s\S]*?)<\/tr>/g;
  let rowMatch;

  while ((rowMatch = rowPattern.exec(article)) !== null) {
    const cells = [...rowMatch[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(
      (match) => match[1]
    );

    if (cells.length < 2) {
      continue;
    }

    const modelMatch = cells[0].match(/<a\b[^>]*>([\s\S]*?)<\/a>/);
    const endpointMatch = cells[1].match(/<a\b[^>]*>([\s\S]*?)<\/a>/);
    if (!modelMatch || !endpointMatch) {
      continue;
    }

    const modelId = stripHtml(modelMatch[1]).replace(/\s*\/\s*/, "/");
    const endpoint = stripHtml(endpointMatch[1]);
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

export function buildModelMap(modelIds, existingKeys, llmModelKeys) {
  const allAvailableModels = [...new Set(modelIds)].sort((a, b) => a.localeCompare(b));
  const availableModelSet = new Set(allAvailableModels);
  const availableModelByKey = new Map();
  for (const modelId of allAvailableModels) {
    const modelKey = toModelKey(modelId);
    if (!availableModelByKey.has(modelKey)) {
      availableModelByKey.set(modelKey, modelId);
    }
  }

  const availableLlmModelSet = new Set(
    allAvailableModels.filter((modelId) =>
      llmModelKeys.has(normalizeModelIdForMatch(modelId))
    )
  );

  const nextMap = new Map();

  for (const [modelKey, upstreamModel] of existingKeys.entries()) {
    const resolvedUpstreamModel = availableModelSet.has(upstreamModel)
      ? upstreamModel
      : availableModelByKey.get(modelKey);

    if (!resolvedUpstreamModel) {
      continue;
    }

    nextMap.set(modelKey, resolvedUpstreamModel);
  }

  const mappedValues = new Set(nextMap.values());

  for (const upstreamModel of allAvailableModels) {
    if (mappedValues.has(upstreamModel)) {
      continue;
    }

    if (!availableLlmModelSet.has(upstreamModel)) {
      continue;
    }

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
