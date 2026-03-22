import {
  MODEL_REGISTRY,
  IGNORED_MODELS,
  type ModelMeta,
  type ModelInfo,
} from "./model-loader.js";

// Re-export types and registry so existing consumers keep working
export { MODEL_REGISTRY, IGNORED_MODELS };
export type { ModelMeta, ModelInfo };

// ---------------------------------------------------------------------------
// Legacy alias helper (NVIDIA NIM)
// ---------------------------------------------------------------------------

function getLegacyNvidiaNimModelAlias(upstreamModel: string): string {
  return upstreamModel
    .replace(/^library\//, "")
    .replace(/[:/]/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-{2,}/g, "-");
}

// ---------------------------------------------------------------------------
// Effective registry — all non-ignored models
// ---------------------------------------------------------------------------

const EFFECTIVE_MODEL_REGISTRY: Record<string, ModelInfo> = { ...MODEL_REGISTRY };

// Filter out ignored models from the effective registry
for (const model of IGNORED_MODELS) {
  delete EFFECTIVE_MODEL_REGISTRY[model];
}

// ---------------------------------------------------------------------------
// Alias lookup — built entirely from TOML data
// ---------------------------------------------------------------------------

const aliasToCanonical: Record<string, string> = {};

for (const [canonical, info] of Object.entries(EFFECTIVE_MODEL_REGISTRY)) {
  // Register TOML-declared aliases
  if (info.aliases) {
    for (const alias of info.aliases) {
      aliasToCanonical[alias] = canonical;
    }
  }

  // Register upstream names as reverse aliases so that a response
  // referencing an upstream name can be resolved back to canonical.
  if (info.upstream) {
    for (const upstreamName of Object.values(info.upstream)) {
      if (!aliasToCanonical[upstreamName]) {
        aliasToCanonical[upstreamName] = canonical;
      }

      // NVIDIA NIM legacy alias (e.g. "meta-llama-3.3-70b-instruct")
      const legacyAlias = getLegacyNvidiaNimModelAlias(upstreamName);
      if (legacyAlias !== upstreamName && !aliasToCanonical[legacyAlias]) {
        aliasToCanonical[legacyAlias] = canonical;
      }
    }
  }
}

const canonicalToAliases: Record<string, string[]> = {};
for (const [alias, canonical] of Object.entries(aliasToCanonical)) {
  if (!canonicalToAliases[canonical]) {
    canonicalToAliases[canonical] = [];
  }
  canonicalToAliases[canonical].push(alias);
}

for (const [canonical, aliases] of Object.entries(canonicalToAliases)) {
  canonicalToAliases[canonical] = Array.from(new Set(aliases)).sort((a, b) =>
    a.localeCompare(b)
  );
}

// ---------------------------------------------------------------------------
// Per-provider model maps — built from TOML [opendum.upstream]
// ---------------------------------------------------------------------------

/** Cached per-provider model map: canonical → upstream name. */
const providerModelMapCache = new Map<string, Record<string, string>>();

/**
 * Build (and cache) the full model map for a provider from the TOML registry.
 * Keys are canonical model IDs, values are upstream model names.
 */
export function getProviderModelMap(provider: string): Record<string, string> {
  const cached = providerModelMapCache.get(provider);
  if (cached) return cached;

  const map: Record<string, string> = {};
  for (const [canonical, info] of Object.entries(EFFECTIVE_MODEL_REGISTRY)) {
    if (!info.providers.includes(provider)) continue;
    map[canonical] = info.upstream?.[provider] ?? canonical;
  }

  providerModelMapCache.set(provider, map);
  return map;
}

/** Cached per-provider model set. */
const providerModelSetCache = new Map<string, Set<string>>();

/**
 * Get the set of canonical model IDs supported by a provider.
 */
export function getProviderModelSet(provider: string): Set<string> {
  const cached = providerModelSetCache.get(provider);
  if (cached) return cached;

  const modelSet = new Set(Object.keys(getProviderModelMap(provider)));
  providerModelSetCache.set(provider, modelSet);
  return modelSet;
}

/**
 * Resolve a canonical model id to the upstream name for a specific provider.
 * Falls back to the canonical name when no upstream mapping exists.
 */
export function getUpstreamModelName(model: string, provider: string): string {
  const canonical = resolveModelAlias(model);
  const info = EFFECTIVE_MODEL_REGISTRY[canonical];
  return info?.upstream?.[provider] ?? canonical;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve model alias to canonical name
 */
export function resolveModelAlias(model: string): string {
  return aliasToCanonical[model] ?? model;
}

/**
 * Get canonical model key and known aliases for lookups.
 */
export function getModelLookupKeys(model: string): string[] {
  const canonical = resolveModelAlias(model);
  const aliases = canonicalToAliases[canonical] ?? [];
  return [canonical, ...aliases];
}

/**
 * Get providers that support a given model
 */
export function getProvidersForModel(model: string): string[] {
  const canonical = resolveModelAlias(model);
  const info = EFFECTIVE_MODEL_REGISTRY[canonical];
  if (!info) {
    return [];
  }

  return [...info.providers];
}

/**
 * Check if a model is supported by any provider
 */
export function isModelSupported(model: string): boolean {
  return getProvidersForModel(model).length > 0;
}

/**
 * Check if a model is supported by a specific provider
 */
export function isModelSupportedByProvider(
  model: string,
  provider: string
): boolean {
  const providers = getProvidersForModel(model);
  return providers.includes(provider);
}

/**
 * Get all supported models (canonical names only)
 */
export function getAllModels(): string[] {
  return Object.keys(EFFECTIVE_MODEL_REGISTRY).filter(
    (model) => getProvidersForModel(model).length > 0
  );
}

/**
 * Get all supported models including aliases
 */
export function getAllModelsWithAliases(): string[] {
  const models: string[] = [];
  for (const [canonical, info] of Object.entries(EFFECTIVE_MODEL_REGISTRY)) {
    if (getProvidersForModel(canonical).length === 0) {
      continue;
    }

    models.push(canonical);
    if (info.aliases) {
      models.push(...info.aliases);
    }
  }
  return models;
}

/**
 * Get models for a specific provider
 */
export function getModelsForProvider(provider: string): string[] {
  const models: string[] = [];
  for (const [model, info] of Object.entries(EFFECTIVE_MODEL_REGISTRY)) {
    if (info.providers.includes(provider)) {
      models.push(model);
      if (info.aliases) {
        models.push(...info.aliases);
      }
    }
  }
  return models;
}

/**
 * Format models for OpenAI /v1/models response
 */
export function formatModelsForOpenAI(): Array<{
  id: string;
  object: string;
  created: number;
  owned_by: string;
}> {
  const now = Math.floor(Date.now() / 1000);
  const models: Array<{
    id: string;
    object: string;
    created: number;
    owned_by: string;
  }> = [];

  for (const model of Object.keys(EFFECTIVE_MODEL_REGISTRY)) {
    const providers = getProvidersForModel(model);
    if (providers.length === 0) {
      continue;
    }

    const ownedBy = providers.join(",");

    models.push({
      id: model,
      object: "model",
      created: now,
      owned_by: ownedBy,
    });
  }

  return models;
}

// ---------------------------------------------------------------------------
// Family helpers — derived from TOML [opendum].family
// ---------------------------------------------------------------------------

/**
 * Get the family of a model from the TOML registry.
 * Returns undefined if the model is not found or has no family set.
 */
export function getModelFamily(modelId: string): string | undefined {
  const canonical = resolveModelAlias(modelId);
  return EFFECTIVE_MODEL_REGISTRY[canonical]?.family;
}

/**
 * Get all unique family names present in the registry.
 */
export function getAllFamilies(): string[] {
  const families = new Set<string>();
  for (const info of Object.values(EFFECTIVE_MODEL_REGISTRY)) {
    if (info.family) families.add(info.family);
  }
  return Array.from(families).sort();
}

/**
 * Build a mapping of family name → array of canonical model IDs.
 * Models without a family are grouped under the key "Others".
 */
export function getModelsByFamily(): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [modelId, info] of Object.entries(EFFECTIVE_MODEL_REGISTRY)) {
    if (getProvidersForModel(modelId).length === 0) continue;
    const family = info.family ?? "Others";
    if (!result[family]) result[family] = [];
    result[family].push(modelId);
  }
  return result;
}
