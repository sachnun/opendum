import { Registry } from "@opendum/models/runtime";
import type { ModelInfo, ProviderAccessRule } from "@opendum/models/runtime";
import { MODEL_ENTRIES } from "virtual:opendum-model-registry";
import { compareModelEntries } from "#shared/model/sort";

export const registry = Registry.fromEntries(MODEL_ENTRIES, { familyFromFolder: true });

export const MODEL_REGISTRY: Record<string, ModelInfo> = registry.entries();
export const IGNORED_MODELS = new Set(registry.ignoredModels());

export type { ModelInfo, ProviderAccessRule };

export function getProviderModelMap(provider: string): Record<string, string> {
  return Object.fromEntries(registry.providerModelMap(provider));
}

export function getProviderModelSet(provider: string): Set<string> {
  return registry.providerModelSet(provider);
}

export function getProviderAccessRule(model: string, provider: string): ProviderAccessRule | null {
  return registry.providerAccessRule(model, provider);
}

export function getAuthlessProviderModels(): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [provider, models] of registry.authlessProviderModels()) {
    result[provider] = [...models].sort((a, b) =>
      compareModelEntries(
        { id: a, family: MODEL_REGISTRY[a]?.family },
        { id: b, family: MODEL_REGISTRY[b]?.family }
      )
    );
  }
  return result;
}

export function resolveModelAlias(model: string): string {
  return registry.resolveAlias(model);
}

export function getModelLookupKeys(model: string): string[] {
  return registry.lookupKeys(model);
}

export function getProvidersForModel(model: string): string[] {
  return registry.providersForModel(model);
}

export function isModelSupported(model: string): boolean {
  return registry.isSupported(model);
}

export function getAllModels(): string[] {
  return registry.allModels();
}

export function getModelFamily(model: string): string | undefined {
  return registry.modelFamily(model) || undefined;
}

export function getAllFamilies(): string[] {
  return registry.families();
}
