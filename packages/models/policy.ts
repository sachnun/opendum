import type { ModelInfo, ProviderAccessRule, ProviderModelConfig } from "./registry.ts";

export type Catalog = {
  info(model: string): ModelInfo | null;
  entries(): Iterable<[string, ModelInfo]>;
};

export class Policy {
  constructor(private readonly catalog: Catalog) {}

  rule(model: string, provider: string): ProviderAccessRule | null {
    const config = this.config(model, provider);
    if (!config) return null;
    if (config.minTier || (config.allowedTiers ?? []).length > 0) {
      return { minTier: config.minTier, allowedTiers: [...(config.allowedTiers ?? [])] };
    }
    return null;
  }

  config(model: string, provider: string): ProviderModelConfig | null {
    const info = this.catalog.info(model);
    if (!info) return null;
    return info.providerConfig?.[provider] ?? null;
  }

  isAuthless(model: string, provider: string): boolean {
    return this.config(model, provider)?.authless === true;
  }

  isFree(model: string, provider: string): boolean {
    return this.config(model, provider)?.free === true;
  }

  authlessModels(): Map<string, string[]> {
    const result = new Map<string, string[]>();
    for (const [model, info] of this.catalog.entries()) {
      for (const provider of info.providers) {
        if (!this.isAuthless(model, provider)) continue;
        const list = result.get(provider) ?? [];
        list.push(model);
        result.set(provider, list);
      }
    }
    for (const [provider, list] of result) {
      result.set(provider, [...list].sort((a, b) => a.localeCompare(b)));
    }
    return result;
  }
}
