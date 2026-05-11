import {
  MODEL_REGISTRY,
  IGNORED_MODELS,
  type ModelInfo,
} from "./loader.js";

// Re-export types and registry so existing consumers keep working
export { MODEL_REGISTRY };

export interface ProviderAccessRule {
  minTier?: string;
}

function getLegacyNvidiaNimModelAlias(upstreamModel: string): string {
  return upstreamModel
    .replace(/^library\//, "")
    .replace(/[:/]/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-{2,}/g, "-");
}

const EFFECTIVE_MODEL_REGISTRY: Record<string, ModelInfo> = { ...MODEL_REGISTRY };

// Filter out ignored models from the effective registry
for (const model of IGNORED_MODELS) {
  Reflect.deleteProperty(EFFECTIVE_MODEL_REGISTRY, model);
}

const aliasToCanonical: Record<string, string> = {};

function getProviderUpstream(info: ModelInfo, provider: string): string | undefined {
  return info.providerConfig?.[provider]?.upstream;
}

for (const [canonical, info] of Object.entries(EFFECTIVE_MODEL_REGISTRY)) {
  // Register JSON-declared aliases
  if (info.aliases) {
    for (const alias of info.aliases) {
      aliasToCanonical[alias] = canonical;
    }
  }

  // Register upstream names as reverse aliases so that a response
  // referencing an upstream name can be resolved back to canonical.
  const upstreamNames = new Set<string>();
  if (info.providerConfig) {
    for (const config of Object.values(info.providerConfig)) {
      if (typeof config.upstream === "string") upstreamNames.add(config.upstream);
    }
  }

  if (upstreamNames.size > 0) {
    for (const upstreamName of upstreamNames) {
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

/** Cached per-provider model map: canonical → upstream name. */
const modelMapCache = new Map<string, Record<string, string>>();

/**
 * Build (and cache) the full model map for a provider from the JSON registry.
 * Keys are canonical model IDs, values are upstream model names.
 */
export function getProviderModelMap(provider: string): Record<string, string> {
  const cached = modelMapCache.get(provider);
  if (cached) return cached;

  const map: Record<string, string> = {};
  for (const [canonical, info] of Object.entries(EFFECTIVE_MODEL_REGISTRY)) {
    if (!info.providers.includes(provider)) continue;
    map[canonical] = getProviderUpstream(info, provider) ?? canonical;
  }

  modelMapCache.set(provider, map);
  return map;
}

/** Cached per-provider model set. */
const modelSetCache = new Map<string, Set<string>>();

/**
 * Get the set of canonical model IDs supported by a provider.
 */
export function getProviderModelSet(provider: string): Set<string> {
  const cached = modelSetCache.get(provider);
  if (cached) return cached;

  const modelSet = new Set(Object.keys(getProviderModelMap(provider)));
  modelSetCache.set(provider, modelSet);
  return modelSet;
}

export function getProviderAccessRule(
  model: string,
  provider: string
): ProviderAccessRule | null {
  const canonical = resolveModelAlias(model);
  const info = EFFECTIVE_MODEL_REGISTRY[canonical];
  const minTier = info?.providerConfig?.[provider]?.minTier;
  return minTier ? { minTier } : null;
}

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
 * Get all supported models (canonical names only)
 */
export function getAllModels(): string[] {
  return Object.keys(EFFECTIVE_MODEL_REGISTRY).filter(
    (model) => getProvidersForModel(model).length > 0
  );
}

/**
 * Get the family of a model from the JSON registry.
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
