import { ProviderName } from "./providers/types";
import {
  NVIDIA_NIM_MODEL_MAP,
  NVIDIA_NIM_MODELS,
} from "./providers/nvidia-nim/constants";
import {
  OLLAMA_CLOUD_MODEL_MAP,
  OLLAMA_CLOUD_MODELS,
} from "./providers/ollama-cloud/constants";
import {
  OPENROUTER_MODEL_MAP,
  OPENROUTER_MODELS,
} from "./providers/openrouter/constants";
import {
  MODEL_REGISTRY,
  IGNORED_MODELS,
  type ModelMeta,
  type ModelInfo,
} from "./model-loader";

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
// Provider support index — tracks which providers offer each model
// ---------------------------------------------------------------------------

const PROVIDER_SUPPORT_INDEX = new Map<string, Set<string>>();

function addProviderSupport(model: string, provider: string): void {
  const providers = PROVIDER_SUPPORT_INDEX.get(model) ?? new Set<string>();
  providers.add(provider);
  PROVIDER_SUPPORT_INDEX.set(model, providers);
}

for (const model of Object.keys(NVIDIA_NIM_MODEL_MAP)) {
  addProviderSupport(model, ProviderName.NVIDIA_NIM);
}

for (const model of Object.keys(OLLAMA_CLOUD_MODEL_MAP)) {
  addProviderSupport(model, ProviderName.OLLAMA_CLOUD);
}

for (const model of Object.keys(OPENROUTER_MODEL_MAP)) {
  addProviderSupport(model, ProviderName.OPENROUTER);
}

const EFFECTIVE_MODEL_REGISTRY: Record<string, ModelInfo> = { ...MODEL_REGISTRY };

// Filter out ignored models from the effective registry
for (const model of IGNORED_MODELS) {
  delete EFFECTIVE_MODEL_REGISTRY[model];
}

// Build reverse lookup for aliases
const aliasToCanonical: Record<string, string> = {};
for (const [canonical, info] of Object.entries(EFFECTIVE_MODEL_REGISTRY)) {
  if (info.aliases) {
    for (const alias of info.aliases) {
      aliasToCanonical[alias] = canonical;
    }
  }
}

function resolveKnownCanonical(model: string): string | null {
  const canonical = aliasToCanonical[model] ?? model;
  return EFFECTIVE_MODEL_REGISTRY[canonical] ? canonical : null;
}

for (const [modelKey, upstreamModel] of Object.entries(OLLAMA_CLOUD_MODEL_MAP)) {
  const canonical = resolveKnownCanonical(modelKey);
  if (!canonical) {
    continue;
  }

  if (!aliasToCanonical[upstreamModel]) {
    aliasToCanonical[upstreamModel] = canonical;
  }
}

for (const [modelKey, upstreamModel] of Object.entries(NVIDIA_NIM_MODEL_MAP)) {
  const canonical = resolveKnownCanonical(modelKey);
  if (!canonical) {
    continue;
  }

  aliasToCanonical[upstreamModel] = canonical;

  const legacyAlias = getLegacyNvidiaNimModelAlias(upstreamModel);
  aliasToCanonical[legacyAlias] = canonical;
}

for (const [modelKey, upstreamModel] of Object.entries(OPENROUTER_MODEL_MAP)) {
  const canonical = resolveKnownCanonical(modelKey);
  if (!canonical) {
    continue;
  }

  if (!aliasToCanonical[upstreamModel]) {
    aliasToCanonical[upstreamModel] = canonical;
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
  canonicalToAliases[canonical] = Array.from(new Set(aliases)).sort((a, b) => a.localeCompare(b));
}

// ---------------------------------------------------------------------------
// Public API — all signatures unchanged from the previous implementation
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

  const lookupKeys = getModelLookupKeys(canonical);
  const providers = new Set<string>(info.providers);

  for (const lookupKey of lookupKeys) {
    const supportedProviders = PROVIDER_SUPPORT_INDEX.get(lookupKey);
    if (!supportedProviders) {
      continue;
    }

    for (const provider of supportedProviders) {
      providers.add(provider);
    }
  }

  if (providers.size === 0) {
    return [];
  }

  return [...providers].filter((provider) => {
    if (provider === ProviderName.OLLAMA_CLOUD) {
      return lookupKeys.some((lookupKey) => OLLAMA_CLOUD_MODELS.has(lookupKey));
    }

    if (provider === ProviderName.NVIDIA_NIM) {
      return lookupKeys.some((lookupKey) => NVIDIA_NIM_MODELS.has(lookupKey));
    }

    if (provider === ProviderName.OPENROUTER) {
      return lookupKeys.some((lookupKey) => OPENROUTER_MODELS.has(lookupKey));
    }

    return true;
  });
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
export function isModelSupportedByProvider(model: string, provider: string): boolean {
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
    if (getProvidersForModel(model).includes(provider)) {
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
