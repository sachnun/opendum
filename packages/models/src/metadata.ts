/**
 * External model registry clients and metadata extraction.
 *
 * Pulls model metadata from OpenRouter, models.dev, LiteLLM, and NVIDIA NIM so
 * the local registry can be enriched with `owner`, `limit`, `cost`, and
 * `modalities` without hand-maintaining those fields.
 */

import { fetchJson } from "./http.ts";
import { buildIndex, resolveCandidates, type IndexedModel } from "./similarity.ts";

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
export const MODELSDEV_URL = "https://models.dev/api.json";
export const LITELLM_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
export const NVIDIA_MODELS_URL = "https://integrate.api.nvidia.com/v1/models";

/** Points granted per USD, mirroring the dashboard points rate (5 points = 1 USD). */
export const POINTS_PER_USD = 5;

/** Local provider -> models.dev provider id, for provider-scoped matching. */
export const PROVIDER_TO_MODELSDEV: Readonly<Record<string, string>> = {
  kilo_code: "kilo",
  openrouter: "openrouter",
  zenmux: "zenmux",
  hyper: "hyper",
  nvidia_nim: "nvidia",
  opencode: "opencode",
  cline: "cline",
  codex: "openai",
  workers_ai: "cloudflare-workers-ai",
};

export type RegistryName = "openrouter" | "modelsdev" | "litellm" | "nvidia";

export type Modality = "text" | "image" | "pdf" | "audio" | "video";

export interface Modalities {
  input: Modality[];
  output: Modality[];
}

export interface ProviderLimits {
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface ModelLimit {
  context?: number;
  output?: number;
}

/** Model price in points per million tokens. 5 points = 1 USD. */
export interface ModelCost {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface RegistryIndex {
  entries: ReadonlyArray<unknown>;
  index: Map<string, IndexedModel<unknown>>;
  byProvider: Record<string, Map<string, IndexedModel<unknown>>>;
}

export type Registries = Partial<Record<RegistryName, RegistryIndex>>;

export interface ModelMetadataInput {
  id: string;
  candidates: Iterable<string>;
  providers: Iterable<string>;
}

export interface ResolvedHit {
  source: RegistryName;
  id: string;
  entry: unknown;
  provider?: string;
}

export interface ResolvedMetadata {
  perProvider: Record<string, ResolvedHit>;
  global: Partial<Record<RegistryName, ResolvedHit>>;
}

export interface ModelMetadataPatch {
  reasoning: boolean | null;
  reasoningEffort: string[] | null;
  providerLimits: Record<string, ProviderLimits>;
  modalities: Modalities | null;
  limits: ModelLimit;
  cost: ModelCost | null;
  resolvedProviders: number;
  minimumProviderContext: number | null;
  maximumProviderContext: number | null;
}

const MODALITY_KEYS: ReadonlySet<string> = new Set(["text", "image", "pdf", "audio", "video"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNumber(value: unknown): number | null {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.trunc(number);
}

function pickNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const number = asNumber(value);
    if (number !== null) return number;
  }
  return null;
}

function cleanModalities(value: unknown): Modality[] | null {
  if (!Array.isArray(value)) return null;
  const cleaned = [...new Set(
    value
      .map((item) => String(item).toLowerCase())
      .filter((item) => MODALITY_KEYS.has(item)),
  )].sort();
  return cleaned.length > 0 ? (cleaned as Modality[]) : null;
}

function readModalities(input: unknown, output: unknown): Modalities | null {
  const inputModalities = cleanModalities(input);
  const outputModalities = cleanModalities(output);
  if (!inputModalities && !outputModalities) return null;
  return { input: inputModalities ?? ["text"], output: outputModalities ?? ["text"] };
}

function limitsFrom(source: RegistryName, entry: unknown): ProviderLimits {
  const record = asRecord(entry);
  if (!record) return {};

  if (source === "openrouter") {
    const topProvider = asRecord(record.top_provider);
    return {
      contextWindow: pickNumber(record.context_length, topProvider?.context_length) ?? undefined,
      maxOutputTokens: pickNumber(topProvider?.max_completion_tokens) ?? undefined,
    };
  }

  if (source === "modelsdev") {
    const limit = asRecord(record.limit);
    return {
      contextWindow: pickNumber(limit?.context) ?? undefined,
      maxOutputTokens: pickNumber(limit?.output) ?? undefined,
    };
  }

  if (source === "litellm") {
    return {
      contextWindow: pickNumber(record.max_input_tokens, record.max_tokens) ?? undefined,
      maxOutputTokens: pickNumber(record.max_output_tokens) ?? undefined,
    };
  }

  return {};
}

function roundPoints(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function scalePoints(value: unknown, factor: number): number | undefined {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return undefined;
  return roundPoints(number * factor);
}

function buildPoints(values: ModelCost): ModelCost | null {
  const points: ModelCost = {};
  if (values.input !== undefined) points.input = values.input;
  if (values.output !== undefined) points.output = values.output;
  if (values.cacheRead !== undefined) points.cacheRead = values.cacheRead;
  if (values.cacheWrite !== undefined) points.cacheWrite = values.cacheWrite;
  return Object.keys(points).length > 0 ? points : null;
}

/**
 * Extract per-million-token prices and convert them to points.
 *
 * `POINTS_PER_USD` mirrors the dashboard points rate (5 points = 1 USD), so a
 * stored value is points per million tokens.
 */
function pointsFrom(source: RegistryName, entry: unknown): ModelCost | null {
  const record = asRecord(entry);
  if (!record) return null;
  const perMillion = 1_000_000 * POINTS_PER_USD;

  if (source === "openrouter") {
    const pricing = asRecord(record.pricing);
    if (!pricing) return null;
    return buildPoints({
      input: scalePoints(pricing.prompt, perMillion),
      output: scalePoints(pricing.completion, perMillion),
      cacheRead: scalePoints(pricing.input_cache_read, perMillion),
      cacheWrite: scalePoints(pricing.input_cache_write, perMillion),
    });
  }

  if (source === "modelsdev") {
    const cost = asRecord(record.cost);
    if (!cost) return null;
    return buildPoints({
      input: scalePoints(cost.input, POINTS_PER_USD),
      output: scalePoints(cost.output, POINTS_PER_USD),
      cacheRead: scalePoints(cost.cache_read, POINTS_PER_USD),
      cacheWrite: scalePoints(cost.cache_write, POINTS_PER_USD),
    });
  }

  if (source === "litellm") {
    return buildPoints({
      input: scalePoints(record.input_cost_per_token, perMillion),
      output: scalePoints(record.output_cost_per_token, perMillion),
      cacheRead: scalePoints(record.cache_read_input_token_cost, perMillion),
      cacheWrite: scalePoints(record.cache_creation_input_token_cost, perMillion),
    });
  }

  return null;
}

function hasProviderLimits(limits: ProviderLimits): boolean {
  return limits.contextWindow !== undefined || limits.maxOutputTokens !== undefined;
}

/**
 * Pick the lowest non-zero price per field across all candidate costs, falling
 * back to zero when every candidate is free. Zero is ignored so free provider
 * tiers do not mask the model's paid reference price.
 */
function mergeCosts(costs: Array<ModelCost | null>): ModelCost | null {
  const present = costs.filter((cost): cost is ModelCost => cost !== null);
  if (present.length === 0) return null;

  const merged: ModelCost = {};
  for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    const values = present.map((cost) => cost[key]);
    const positive = values.filter((value): value is number => typeof value === "number" && value > 0);
    if (positive.length > 0) merged[key] = Math.min(...positive);
    else if (values.some((value) => value === 0)) merged[key] = 0;
  }

  return Object.keys(merged).length > 0 ? merged : null;
}

function modalitiesFrom(source: RegistryName, entry: unknown): Modalities | null {
  const record = asRecord(entry);
  if (!record) return null;

  if (source === "openrouter") {
    const architecture = asRecord(record.architecture);
    if (!architecture) return null;
    return readModalities(architecture.input_modalities, architecture.output_modalities);
  }

  if (source === "modelsdev") {
    const modalities = asRecord(record.modalities);
    if (!modalities) return null;
    return readModalities(modalities.input, modalities.output);
  }

  return null;
}

function reasoningFrom(source: RegistryName, entry: unknown): boolean | null {
  const record = asRecord(entry);
  if (!record) return null;

  if (source === "openrouter") {
    const reasoning = record.reasoning;
    if (typeof reasoning === "boolean") return reasoning;
    if (reasoning && typeof reasoning === "object") return true;
    const supported = Array.isArray(record.supported_parameters) ? record.supported_parameters : [];
    if (supported.includes("reasoning")) return true;
    return null;
  }

  if (source === "modelsdev" && typeof record.reasoning === "boolean") {
    return record.reasoning;
  }

  if (source === "litellm" && typeof record.supports_reasoning === "boolean") {
    return record.supports_reasoning;
  }

  return null;
}

const REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

function readEfforts(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const supported = new Set(value.map((item) => String(item).toLowerCase().trim()));
  const efforts = REASONING_EFFORTS.filter((effort) => supported.has(effort));
  return efforts.length > 0 ? efforts : null;
}

function effortsFrom(source: RegistryName, entry: unknown): string[] | null {
  const record = asRecord(entry);
  if (!record) return null;

  if (source === "openrouter") {
    return readEfforts(asRecord(record.reasoning)?.supported_efforts);
  }

  if (source === "modelsdev" && Array.isArray(record.reasoning_options)) {
    for (const option of record.reasoning_options) {
      const optionRecord = asRecord(option);
      if (optionRecord?.type !== "effort") continue;
      const efforts = readEfforts(optionRecord.values);
      if (efforts) return efforts;
    }
  }

  return null;
}

function firstDefined<T>(values: Array<T | null | undefined>): T | null {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    return value;
  }
  return null;
}

interface SourceExtractor {
  name: RegistryName;
  url: string;
  extract: (payload: unknown) => Array<{ id: string; name?: string; provider?: string; entry: unknown }>;
}

const SOURCES: SourceExtractor[] = [
  {
    name: "openrouter",
    url: OPENROUTER_MODELS_URL,
    extract: (payload) => {
      const data = asRecord(payload)?.data;
      if (!Array.isArray(data)) return [];
      return data.flatMap((item) => {
        const record = asRecord(item);
        const id = typeof record?.id === "string" ? record.id : "";
        if (!id) return [];
        return [{ id, name: typeof record?.name === "string" ? record.name : undefined, provider: "openrouter", entry: item }];
      });
    },
  },
  {
    name: "modelsdev",
    url: MODELSDEV_URL,
    extract: (payload) => {
      const providers = asRecord(payload);
      if (!providers) return [];
      return Object.entries(providers).flatMap(([providerId, provider]) => {
        const models = asRecord(asRecord(provider)?.models);
        if (!models) return [];
        return Object.entries(models).flatMap(([modelId, item]) => {
          const name = asRecord(item)?.name;
          return [{ id: modelId, name: typeof name === "string" ? name : undefined, provider: providerId, entry: item }];
        });
      });
    },
  },
  {
    name: "litellm",
    url: LITELLM_URL,
    extract: (payload) => {
      const entries = asRecord(payload);
      if (!entries) return [];
      return Object.entries(entries).map(([id, item]) => {
        const record = asRecord(item);
        const name = record?.name;
        const provider = record?.litellm_provider;
        return {
          id,
          name: typeof name === "string" ? name : id,
          provider: typeof provider === "string" ? provider : undefined,
          entry: item,
        };
      });
    },
  },
  {
    name: "nvidia",
    url: NVIDIA_MODELS_URL,
    extract: (payload) => {
      const data = asRecord(payload)?.data;
      if (!Array.isArray(data)) return [];
      return data.flatMap((item) => {
        const record = asRecord(item);
        const id = typeof record?.id === "string" ? record.id : "";
        if (!id) return [];
        const ownedBy = record?.owned_by;
        return [{ id, name: id, provider: typeof ownedBy === "string" ? ownedBy : undefined, entry: item }];
      });
    },
  },
];

function groupByProvider(
  entries: ReadonlyArray<{ id: string; name?: string; provider?: string; entry: unknown }>,
  source: string,
): Record<string, Map<string, IndexedModel<unknown>>> {
  const groups: Record<string, Array<{ id: string; name?: string; provider?: string; entry: unknown }>> = {};
  for (const item of entries) {
    if (!item.provider) continue;
    groups[item.provider] ??= [];
    groups[item.provider]!.push(item);
  }

  const result: Record<string, Map<string, IndexedModel<unknown>>> = {};
  for (const [providerId, items] of Object.entries(groups)) {
    result[providerId] = buildIndex(items, source);
  }
  return result;
}

/**
 * Fetch every external registry.
 *
 * Sources are optional: a failure yields `undefined` so a refresh never aborts
 * because one upstream is unavailable.
 */
export async function fetchExternalRegistries(
  options: { logger?: (message: string) => void } = {},
): Promise<Registries> {
  const logger = options.logger ?? (() => {});
  const registries: Registries = {};

  for (const source of SOURCES) {
    try {
      const payload = await fetchJson(source.url, { label: `external registry ${source.name}` });
      const entries = source.extract(payload);
      registries[source.name] = {
        entries,
        index: buildIndex(entries, source.name),
        byProvider: groupByProvider(entries, source.name),
      };
      logger(`[metadata] ${source.name}: ${entries.length} entries`);
    } catch (error) {
      logger(`[metadata] ${source.name} unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return registries;
}

function pickHit<TEntry>(
  result: { exact: IndexedModel<TEntry> | null; match: IndexedModel<TEntry> | null },
): IndexedModel<TEntry> | null {
  return result.exact ?? result.match;
}

export function resolveModelMetadata(
  model: ModelMetadataInput,
  registries: Registries,
): ResolvedMetadata {
  const candidates = [...model.candidates].filter(Boolean);
  const providers = [...model.providers];
  const perProvider: Record<string, ResolvedHit> = {};

  for (const provider of providers) {
    const modelsdevId = PROVIDER_TO_MODELSDEV[provider];
    if (!modelsdevId) continue;
    const index = registries.modelsdev?.byProvider[modelsdevId];
    if (!index) continue;
    const hit = pickHit(resolveCandidates(candidates, index));
    if (hit) perProvider[provider] = { source: "modelsdev", id: hit.id, entry: hit.entry, provider: hit.provider };
  }

  if (providers.includes("openrouter") && registries.openrouter) {
    const hit = pickHit(resolveCandidates(candidates, registries.openrouter.index));
    if (hit) perProvider.openrouter = { source: "openrouter", id: hit.id, entry: hit.entry, provider: hit.provider };
  }

  if (providers.includes("nvidia_nim") && registries.nvidia) {
    const hit = pickHit(resolveCandidates(candidates, registries.nvidia.index));
    if (hit) perProvider.nvidia_nim = { source: "nvidia", id: hit.id, entry: hit.entry, provider: hit.provider };
  }

  const global: Partial<Record<RegistryName, ResolvedHit>> = {};
  for (const name of ["modelsdev", "openrouter", "litellm"] as const) {
    const registry = registries[name];
    if (!registry) continue;
    const hit = pickHit(resolveCandidates(candidates, registry.index));
    if (hit) global[name] = { source: name, id: hit.id, entry: hit.entry, provider: hit.provider };
  }

  return { perProvider, global };
}

export function buildModelPatch(
  model: ModelMetadataInput,
  resolved: ResolvedMetadata,
): ModelMetadataPatch {
  const providerOrder = [...model.providers];
  const candidates: Array<ResolvedHit & { scope: "provider" | "global" }> = [];

  for (const provider of providerOrder) {
    const hit = resolved.perProvider[provider];
    if (hit) candidates.push({ ...hit, scope: "provider" });
  }
  for (const hit of Object.values(resolved.global)) {
    if (hit) candidates.push({ ...hit, scope: "global" });
  }

  const providerLimits: Record<string, ProviderLimits> = {};
  for (const [provider, hit] of Object.entries(resolved.perProvider)) {
    const limits = limitsFrom(hit.source, hit.entry);
    if (hasProviderLimits(limits)) providerLimits[provider] = limits;
  }

  const globalFallback = candidates.find((item) => item.scope === "global" && item.source === "modelsdev")
    ?? candidates.find((item) => item.scope === "global");
  for (const provider of providerOrder) {
    if (providerLimits[provider] || !globalFallback) continue;
    const limits = limitsFrom(globalFallback.source, globalFallback.entry);
    if (hasProviderLimits(limits)) providerLimits[provider] = limits;
  }

  const modalities = firstDefined(candidates.map((item) => modalitiesFrom(item.source, item.entry)));

  const reasoning = firstDefined(candidates.map((item) => reasoningFrom(item.source, item.entry)));

  const reasoningEffort = firstDefined(candidates.map((item) => effortsFrom(item.source, item.entry)));

  const cost = mergeCosts(candidates.map((item) => pointsFrom(item.source, item.entry)));

  const contexts = Object.values(providerLimits)
    .map((item) => item.contextWindow)
    .filter((value): value is number => typeof value === "number");
  const outputs = Object.values(providerLimits)
    .map((item) => item.maxOutputTokens)
    .filter((value): value is number => typeof value === "number");

  const limits: ModelLimit = {};
  if (contexts.length > 0) limits.context = Math.max(...contexts);
  if (outputs.length > 0) limits.output = Math.max(...outputs);

  return {
    reasoning,
    reasoningEffort,
    providerLimits,
    modalities,
    limits,
    cost,
    resolvedProviders: Object.keys(resolved.perProvider).length,
    minimumProviderContext: contexts.length > 0 ? Math.min(...contexts) : null,
    maximumProviderContext: contexts.length > 0 ? Math.max(...contexts) : null,
  };
}
