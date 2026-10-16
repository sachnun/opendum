import { Registry } from "@opendum/models/runtime";
import type { ModelInfo, ProviderAccessRule } from "@opendum/models/runtime";
import { compareModelEntries } from "@opendum/models/sort";
import { resolveModelsDirForService } from "../../../core/context.js";

export const registry = Registry.load(resolveModelsDirForService(), { familyFromFolder: true });

export const MODEL_REGISTRY: Record<string, ModelInfo> = registry.entries();
export const IGNORED_MODELS = new Set(registry.ignoredModels());

export type { ModelInfo, ProviderAccessRule };

export function getProviderModelMap(provider: string): Record<string, string> {
  return Object.fromEntries(registry.modelMap(provider));
}

export function getProviderModelSet(provider: string): Set<string> {
  return registry.modelSet(provider);
}

export function getProviderAccessRule(model: string, provider: string): ProviderAccessRule | null {
  return registry.rule(model, provider);
}

export function getAuthlessProviderModels(): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [provider, models] of registry.authlessModels()) {
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
  return registry.providers(model);
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
