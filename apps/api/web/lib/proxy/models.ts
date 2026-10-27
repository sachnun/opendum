import { Registry, type ModelInfo, type ProviderAccessRule } from "@opendum/models/runtime";
import { compareEntries } from "@opendum/models/sort";
import { dirFor } from "@opendum/api/core/context";

export const registry = Registry.load(dirFor(), { familyFromFolder: true });

export const MODEL_REGISTRY: Record<string, ModelInfo> = registry.entries();
export const IGNORED_MODELS = new Set(registry.ignoredModels());

export type { ModelInfo, ProviderAccessRule };

export function providerModels(provider: string): Record<string, string> {
  return Object.fromEntries(registry.modelMap(provider));
}

export function providerSet(provider: string): Set<string> {
  return registry.modelSet(provider);
}

export function ruleOf(model: string, provider: string): ProviderAccessRule | null {
  return registry.rule(model, provider);
}

export function authlessModels(): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [provider, models] of registry.authlessModels()) {
    result[provider] = [...models].sort((a, b) =>
      compareEntries(
        { id: a, family: MODEL_REGISTRY[a]?.family },
        { id: b, family: MODEL_REGISTRY[b]?.family }
      )
    );
  }
  return result;
}

export function aliasOf(model: string): string {
  return registry.resolveAlias(model);
}

export function keysOf(model: string): string[] {
  return registry.lookupKeys(model);
}

export function providersFor(model: string): string[] {
  return registry.providers(model);
}

export function supportsModel(model: string): boolean {
  return registry.isSupported(model);
}

export function allModels(): string[] {
  return registry.allModels();
}

export function familyOf(model: string): string | undefined {
  return registry.modelFamily(model) || undefined;
}

export function allFamilies(): string[] {
  return registry.families();
}
