import { Effect, Option, Schema } from "effect";
import { raise } from "@opendum/models/refresh/sources/raise";
import { compareText } from "@opendum/models/compare";
import { buildIndex, upstream } from "@opendum/models/model-store";
import { fetchDecoded } from "@opendum/models/sync/http";
import { afterFirstSlash, standardKey } from "@opendum/models/refresh/sources/keys";
import { sourceOf, type ModelSource, type SourceContext, type SourceResult } from "@opendum/models/refresh/sources/types";

const MODELS_URL = "https://integrate.api.nvidia.com/v1/models";
const DOCS_URLS = [
  "https://docs.api.nvidia.com/nim/reference/llm-apis",
  "https://docs.api.nvidia.com/nim/reference/multimodal-apis",
  "https://docs.api.nvidia.com/nim/reference/visual-models-apis",
];
const PROVIDER = "nvidia_nim";

const EXCLUDED_TOKENS = [
  "detection", "embed", "embedding", "guard", "nemoretriever", "parse", "rerank", "retriever",
  "safety", "vila",
];

const NON_CHAT_MARKERS = [
  "embedding", "classification", "classify", "detection", "generate dna", "generation",
  "ranking", "rerank", "retrieval", "search post", "status polling",
];

const CHAT_MARKERS = [
  "chat conversation", "chat completion", "create completion", "request response from the model",
];

const LIBRARY_PREFIX = "library/";
const ROW = /<tr>([\s\S]*?)<\/tr>/g;
const CELL = /<td[^>]*>([\s\S]*?)<\/td>/g;
const LINK = /<a\b[^>]*>([\s\S]*?)<\/a>/;
const TAG = /<[^>]*>/g;

const Payload = Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) });
const decodePayload = Schema.decodeUnknownOption(Payload);

const decodeHtml = (value: string): string =>
  value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

const stripHtml = (value: string): string =>
  decodeHtml(value.replace(TAG, "")).replace(/\s+/g, " ").trim();

const normalizeKey = (modelId: string): string =>
  modelId
    .replace(LIBRARY_PREFIX, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const excluded = (modelId: string): boolean =>
  EXCLUDED_TOKENS.some((token) => normalizeKey(modelId).includes(token));

const chatModel = (description: string): boolean => {
  const normalized = description.toLowerCase();
  if (NON_CHAT_MARKERS.some((marker) => normalized.includes(marker))) return false;
  return CHAT_MARKERS.some((marker) => normalized.includes(marker));
};

const generativeKeys = (html: string): ReadonlySet<string> => {
  const start = html.indexOf('data-testid="RDMD"');
  const end = start === -1 ? -1 : html.indexOf("</article>", start);
  const article = start === -1 ? html : html.slice(start, end === -1 ? undefined : end);

  const keys = new Set<string>();
  for (const row of article.matchAll(ROW)) {
    const cells = [...(row[1] ?? "").matchAll(CELL)].map((cell) => cell[1] ?? "");
    if (cells.length < 2) continue;

    const modelMatch = LINK.exec(cells[0] ?? "");
    const endpointMatch = LINK.exec(cells[1] ?? "");
    if (!modelMatch || !endpointMatch) continue;

    const modelId = stripHtml(modelMatch[1] ?? "").replace(/\s*\/\s*/, "/");
    const endpoint = stripHtml(endpointMatch[1] ?? "");
    if (modelId.includes("/") && !excluded(modelId) && chatModel(endpoint)) {
      keys.add(normalizeKey(modelId));
    }
  }
  return keys;
};

const upstreamIds = (payload: unknown): ReadonlyArray<string> =>
  Option.match(decodePayload(payload), {
    onNone: () => [],
    onSome: (value) => value.data.map((entry) => entry.id),
  });

const existingKeys = (ctx: SourceContext): Map<string, string> => {
  const keys = new Map<string, string>();
  for (const [modelId, entry] of Object.entries(buildIndex(ctx.modelsDir))) {
    if (!(entry.data.providers ?? []).includes(PROVIDER)) continue;
    const name = upstream(entry.data, PROVIDER, modelId);
    if (name) keys.set(entry.id || modelId, name);
  }
  return keys;
};

const buildMap = (
  available: ReadonlyArray<string>,
  existing: ReadonlyMap<string, string>,
  generative: ReadonlySet<string>
): Map<string, string> => {
  const all = [...new Set(available)].sort((left, right) => compareText(left, right));
  const availableSet = new Set(all);

  const byKey = new Map<string, string>();
  for (const modelId of all) {
    const key = standardKey(afterFirstSlash(modelId));
    if (!byKey.has(key)) byKey.set(key, modelId);
  }

  const generativeSet = new Set(all.filter((modelId) => generative.has(normalizeKey(modelId))));

  const next = new Map<string, string>();
  for (const [modelKey, upstreamName] of existing) {
    const resolved = availableSet.has(upstreamName) ? upstreamName : byKey.get(modelKey);
    if (!resolved) continue;
    next.set(modelKey, resolved);
  }

  const mapped = new Set(next.values());
  for (const upstreamName of all) {
    if (mapped.has(upstreamName) || !generativeSet.has(upstreamName)) continue;
    const base = standardKey(afterFirstSlash(upstreamName));
    let key = base;
    let suffix = 2;
    while (next.has(key) && next.get(key) !== upstreamName) {
      key = `${base}-${suffix}`;
      suffix += 1;
    }
    next.set(key, upstreamName);
    mapped.add(upstreamName);
  }

  return new Map([...next.entries()].sort(([left], [right]) => compareText(left, right)));
};

export const nvidiaSource: ModelSource = {
  provider: PROVIDER,
  label: "Nvidia",
  order: 35,
  phase: "fetch",

  fetch: (ctx) =>
    Effect.gen(function* () {
      const payload = yield* fetchDecoded(
        MODELS_URL,
        { label: "Nvidia NIM models", headers: { Accept: "application/json" } },
        async (response) => upstreamIds(await response.json())
      );
      if (payload.length === 0) raise(new Error("unexpected Nvidia /v1/models payload"));

      const pages = yield* Effect.forEach(
        DOCS_URLS,
        (url) =>
          fetchDecoded(
            url,
            { label: "Nvidia model docs", headers: { Accept: "text/html" } },
            (response) => response.text()
          ),
        { concurrency: DOCS_URLS.length }
      );

      const generative = new Set<string>();
      for (const page of pages) {
        for (const key of generativeKeys(page)) generative.add(key);
      }
      if (generative.size === 0) raise(new Error("unexpected Nvidia model docs payload"));

      return sourceOf(buildMap(payload, existingKeys(ctx), generative)) satisfies SourceResult;
    }).pipe(Effect.mapError((cause) => ({ provider: PROVIDER, message: cause.message }))),
};
