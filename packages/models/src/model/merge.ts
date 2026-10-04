import type { ModelData, ProviderModelConfig } from "#models/model/types.ts";

export const GENERATED_FIELDS: ReadonlySet<string> = new Set([
  "id",
  "providers",
  "aliases",
  "reasoning",
  "reasoning_effort",
  "modalities",
  "limit",
  "cost",
  "scores",
]);

export const GENERATED_PROVIDER_FIELDS: ReadonlySet<string> = new Set([
  "upstream",
  "contextWindow",
  "maxOutputTokens",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (isRecord(value)) return Object.keys(value).length === 0;
  return false;
}

function mergeProviderConfig(
  generated: Record<string, ProviderModelConfig> | undefined,
  authored: Record<string, ProviderModelConfig> | undefined,
): Record<string, ProviderModelConfig> | undefined {
  if (!generated && !authored) return undefined;
  const merged: Record<string, ProviderModelConfig> = {};
  for (const provider of new Set([...Object.keys(generated ?? {}), ...Object.keys(authored ?? {})])) {
    merged[provider] = { ...(generated?.[provider] ?? {}), ...(authored?.[provider] ?? {}) };
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function mergeModelData(
  generated: ModelData | undefined,
  authored: ModelData | undefined,
): ModelData {
  const base = generated ?? {};
  const over = authored ?? {};
  const merged: ModelData = { ...base, ...over };

  const providerConfig = mergeProviderConfig(base.providerConfig, over.providerConfig);
  if (providerConfig) merged.providerConfig = providerConfig;
  else delete merged.providerConfig;

  const aliases = [...new Set([...(base.aliases ?? []), ...(over.aliases ?? [])])].sort();
  if (aliases.length > 0) merged.aliases = aliases;
  else delete merged.aliases;

  for (const key of Object.keys(merged)) {
    if (isEmpty(merged[key])) delete merged[key];
  }
  return merged;
}

export interface SplitModelData {
  generated: ModelData;
  authored: ModelData;
}

export function splitModelData(data: ModelData): SplitModelData {
  const generated: ModelData = {};
  const authored: ModelData = {};

  for (const [key, value] of Object.entries(data)) {
    if (isEmpty(value)) continue;
    if (key === "ignored" && value === false) continue;
    if (GENERATED_FIELDS.has(key)) generated[key] = value;
    else authored[key] = value;
  }

  const generatedProviders: Record<string, ProviderModelConfig> = {};
  const authoredProviders: Record<string, ProviderModelConfig> = {};
  for (const [provider, config] of Object.entries(data.providerConfig ?? {})) {
    const generatedConfig: ProviderModelConfig = {};
    const authoredConfig: ProviderModelConfig = {};
    for (const [key, value] of Object.entries(config)) {
      if (isEmpty(value)) continue;
      if (GENERATED_PROVIDER_FIELDS.has(key)) generatedConfig[key] = value;
      else authoredConfig[key] = value;
    }
    if (!isEmpty(generatedConfig)) generatedProviders[provider] = generatedConfig;
    if (!isEmpty(authoredConfig)) authoredProviders[provider] = authoredConfig;
  }
  delete generated.providerConfig;
  delete authored.providerConfig;
  if (!isEmpty(generatedProviders)) generated.providerConfig = generatedProviders;
  if (!isEmpty(authoredProviders)) authored.providerConfig = authoredProviders;

  return { generated, authored };
}
