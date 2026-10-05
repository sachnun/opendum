import { POINTS_PER_USD } from "#models/model/metadata-constants.ts";
import type { Modality, Modalities, ModelCost, ProviderLimits, RegistryName } from "#models/model/metadata-types.ts";

const MODALITY_KEYS: ReadonlySet<string> = new Set(["text", "image", "pdf", "audio", "video"]);

export function asRecord(value: unknown): Record<string, unknown> | null {
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

export function limitsFrom(source: RegistryName, entry: unknown): ProviderLimits {
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

export function pointsFrom(source: RegistryName, entry: unknown): ModelCost | null {
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

export function hasProviderLimits(limits: ProviderLimits): boolean {
  return limits.contextWindow !== undefined || limits.maxOutputTokens !== undefined;
}

export function mergeCosts(costs: Array<ModelCost | null>): ModelCost | null {
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

export function modalitiesFrom(source: RegistryName, entry: unknown): Modalities | null {
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

export function reasoningFrom(source: RegistryName, entry: unknown): boolean | null {
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

export function effortsFrom(source: RegistryName, entry: unknown): string[] | null {
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

export function firstDefined<T>(values: Array<T | null | undefined>): T | null {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    return value;
  }
  return null;
}
