import { uniqueSorted } from "./collections.ts";
import type { ModelInfo } from "./registry.ts";

export type ProviderModelSource = {
  canonical(model: string): string;
  info(model: string): ModelInfo | null;
  entries(): Iterable<[string, ModelInfo]>;
};

export class ProviderModelView {
  private readonly modelMapCache = new Map<string, Map<string, string>>();
  private readonly modelSetCache = new Map<string, Set<string>>();

  constructor(private readonly source: ProviderModelSource) {}

  providersForModel(model: string): string[] {
    const info = this.source.info(this.source.canonical(model));
    return info ? [...info.providers] : [];
  }

  upstreamModelName(model: string, provider: string): string {
    const canonical = this.source.canonical(model);
    const info = this.source.info(canonical);
    if (!info) return canonical;
    const upstream = info.providerConfig?.[provider]?.upstream;
    return upstream && upstream.length > 0 ? upstream : canonical;
  }

  providerModelMap(provider: string): Map<string, string> {
    const cached = this.modelMapCache.get(provider);
    if (cached) return cached;
    const result = new Map<string, string>();
    for (const [canonical, info] of this.source.entries()) {
      if (!info.providers.includes(provider)) continue;
      const upstream = info.providerConfig?.[provider]?.upstream;
      result.set(canonical, upstream && upstream.length > 0 ? upstream : canonical);
    }
    this.modelMapCache.set(provider, result);
    return result;
  }

  providerModelSet(provider: string): Set<string> {
    const cached = this.modelSetCache.get(provider);
    if (cached) return cached;
    const set = new Set(this.providerModelMap(provider).keys());
    this.modelSetCache.set(provider, set);
    return set;
  }

  modelsForProvider(provider: string): string[] {
    const values: string[] = [];
    for (const [model, info] of this.source.entries()) {
      if (info.providers.includes(provider)) values.push(model);
    }
    return uniqueSorted(values);
  }
}
