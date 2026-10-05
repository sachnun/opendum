import { inferFamilyFromFolder } from "#models/model/families.ts";
import {
  legacyNvidiaAlias,
  type ModelCost,
  type ModelEntry,
  type ModelInfo,
  type ProviderAccessRule,
  type ProviderModelConfig,
} from "#models/registry/runtime.ts";
import { makeCandidate, type SuggestionCandidate } from "#models/registry/suggest.ts";

function compactStrings(values: string[] | undefined): string[] {
  if (!values) return [];
  return values.map((value) => value.trim()).filter((value) => value.length > 0);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))].sort((a, b) => a.localeCompare(b));
}

function uniqueSortedStable(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (value.length === 0 || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

export class RegistryStore {
  protected readonly models = new Map<string, ModelInfo>();
  protected readonly effective = new Map<string, ModelInfo>();
  protected readonly ignored = new Set<string>();
  protected readonly aliasToCanonical = new Map<string, string>();
  protected readonly foldedAliasToCanonical = new Map<string, string>();
  protected readonly canonicalToAliases = new Map<string, string[]>();
  protected readonly providerModelMapCache = new Map<string, Map<string, string>>();
  protected readonly providerModelSetCache = new Map<string, Set<string>>();
  protected readonly suggestionModels: SuggestionCandidate[] = [];
  protected readonly suggestionProviders = new Map<string, SuggestionCandidate[]>();

  protected constructor(entries: ModelEntry[], options: { familyFromFolder?: boolean } = {}) {
    for (const entry of entries) {
      const info: ModelInfo = { ...entry.info };
      info.id = (info.id ?? "").trim();
      info.providers = compactStrings(info.providers);
      info.aliases = compactStrings(info.aliases);
      if (entry.owner) info.owner = entry.owner;
      if (options.familyFromFolder && !info.family && entry.owner) {
        info.family = inferFamilyFromFolder(entry.owner) ?? entry.owner;
      }
      const modelId = info.id ? info.id : entry.fileId;
      this.mergeModelInfo(modelId, entry.fileId, info);
      if (info.ignored) this.ignored.add(modelId);
    }
    this.buildAliases();
    this.buildSuggestionCandidates();
  }

  private mergeModelInfo(modelId: string, fileId: string, info: ModelInfo): void {
    if (!info.id) info.id = modelId;
    const aliases = [...(info.aliases ?? [])];
    if (fileId !== modelId) aliases.push(fileId);

    const existing = this.models.get(modelId);
    if (!existing) {
      const stored = { ...info, aliases: uniqueSorted(aliases) };
      this.models.set(modelId, stored);
      if (!stored.ignored) this.effective.set(modelId, stored);
      return;
    }

    const merged: ModelInfo = { ...existing };
    merged.id = modelId;
    merged.providers = uniqueSorted([...(existing.providers ?? []), ...(info.providers ?? [])]);
    merged.aliases = uniqueSorted([...(existing.aliases ?? []), ...aliases]);
    if (!merged.description) merged.description = info.description;
    if (!merged.family) merged.family = info.family;
    merged.ignored = Boolean(existing.ignored && info.ignored);
    if (merged.reasoning == null) merged.reasoning = info.reasoning;
    if (merged.reasoning_effort == null) merged.reasoning_effort = info.reasoning_effort;
    if (merged.modalities == null) merged.modalities = info.modalities;
    if (info.providerConfig && Object.keys(info.providerConfig).length > 0) {
      merged.providerConfig = { ...(merged.providerConfig ?? {}), ...info.providerConfig };
    }

    this.models.set(modelId, merged);
    if (!merged.ignored) this.effective.set(modelId, merged);
    else this.effective.delete(modelId);
  }

  private assignAlias(alias: string, canonical: string): void {
    const trimmed = alias.trim();
    if (!trimmed) return;
    if (this.effective.has(trimmed)) return;
    if (this.aliasToCanonical.has(trimmed)) return;
    this.aliasToCanonical.set(trimmed, canonical);
  }

  private buildAliases(): void {
    const canonicals = [...this.effective.keys()].sort((a, b) => a.localeCompare(b));
    for (const canonical of canonicals) this.aliasToCanonical.set(canonical, canonical);
    for (const canonical of canonicals) {
      const info = this.effective.get(canonical) as ModelInfo;
      if (info.id && info.id !== canonical) this.assignAlias(info.id, canonical);
      for (const alias of info.aliases ?? []) this.assignAlias(alias, canonical);
    }

    const upstreamNames = new Map<string, string>();
    for (const canonical of canonicals) {
      const info = this.effective.get(canonical) as ModelInfo;
      const providers = Object.keys(info.providerConfig ?? {}).sort((a, b) => a.localeCompare(b));
      for (const provider of providers) {
        const upstream = (info.providerConfig?.[provider]?.upstream ?? "").trim();
        if (!upstream || upstreamNames.has(upstream)) continue;
        upstreamNames.set(upstream, canonical);
      }
    }
    for (const upstreamName of [...upstreamNames.keys()].sort((a, b) => a.localeCompare(b))) {
      const canonical = upstreamNames.get(upstreamName) as string;
      if (!this.aliasToCanonical.has(upstreamName)) this.aliasToCanonical.set(upstreamName, canonical);
      const legacy = legacyNvidiaAlias(upstreamName);
      if (legacy !== upstreamName && !this.aliasToCanonical.has(legacy)) {
        this.aliasToCanonical.set(legacy, canonical);
      }
    }

    for (const alias of [...this.aliasToCanonical.keys()].sort((a, b) => a.localeCompare(b))) {
      const canonical = this.aliasToCanonical.get(alias) as string;
      if (alias === canonical) continue;
      const list = this.canonicalToAliases.get(canonical) ?? [];
      list.push(alias);
      this.canonicalToAliases.set(canonical, list);
    }
    for (const [canonical, aliases] of this.canonicalToAliases) {
      this.canonicalToAliases.set(canonical, uniqueSorted(aliases));
    }

    this.buildFoldedAliases();
  }

  private buildFoldedAliases(): void {
    const canonicals = [...this.effective.keys()].sort((a, b) => a.localeCompare(b));
    for (const canonical of canonicals) {
      const key = canonical.toLowerCase();
      if (!this.foldedAliasToCanonical.has(key)) this.foldedAliasToCanonical.set(key, canonical);
    }
    const aliases = [...this.aliasToCanonical.keys()].sort((a, b) => a.localeCompare(b));
    for (const alias of aliases) {
      const key = alias.toLowerCase();
      if (!this.foldedAliasToCanonical.has(key)) {
        this.foldedAliasToCanonical.set(key, this.aliasToCanonical.get(alias) as string);
      }
    }
  }

  private buildSuggestionCandidates(): void {
    for (const model of this.allModels()) {
      const candidate = this.newCandidate(model);
      this.suggestionModels.push(candidate);
      const info = this.effective.get(model) as ModelInfo;
      for (const provider of info.providers) {
        const list = this.suggestionProviders.get(provider) ?? [];
        list.push(candidate);
        this.suggestionProviders.set(provider, list);
      }
    }
    for (const list of this.suggestionProviders.values()) {
      list.sort((a, b) => a.value.localeCompare(b.value));
    }
  }

  protected newCandidate(value: string): SuggestionCandidate {
    return makeCandidate(value);
  }

  resolveAlias(model: string): string {
    const trimmed = model.trim();
    if (!trimmed) return trimmed;
    const direct = this.aliasToCanonical.get(trimmed);
    if (direct !== undefined) return direct;
    const folded = this.foldedAliasToCanonical.get(trimmed.toLowerCase());
    if (folded !== undefined) return folded;
    return trimmed;
  }

  lookupKeys(model: string): string[] {
    const canonical = this.resolveAlias(model);
    return uniqueSortedStable([canonical, ...(this.canonicalToAliases.get(canonical) ?? [])]);
  }

  providersForModel(model: string): string[] {
    const info = this.effective.get(this.resolveAlias(model));
    return info ? [...info.providers] : [];
  }

  isSupported(model: string): boolean {
    return this.providersForModel(model).length > 0;
  }

  isSupportedByProvider(model: string, provider: string): boolean {
    return this.providersForModel(model).includes(provider);
  }

  upstreamModelName(model: string, provider: string): string {
    const canonical = this.resolveAlias(model);
    const info = this.effective.get(canonical);
    if (!info) return canonical;
    const upstream = info.providerConfig?.[provider]?.upstream;
    return upstream && upstream.length > 0 ? upstream : canonical;
  }

  providerAccessRule(model: string, provider: string): ProviderAccessRule | null {
    const info = this.effective.get(this.resolveAlias(model));
    if (!info) return null;
    const config = info.providerConfig?.[provider];
    if (!config) return null;
    if (config.minTier || (config.allowedTiers ?? []).length > 0) {
      return { minTier: config.minTier, allowedTiers: [...(config.allowedTiers ?? [])] };
    }
    return null;
  }

  providerModelConfig(model: string, provider: string): ProviderModelConfig | null {
    const info = this.effective.get(this.resolveAlias(model));
    if (!info) return null;
    return info.providerConfig?.[provider] ?? null;
  }

  isAuthlessProviderModel(model: string, provider: string): boolean {
    return this.providerModelConfig(model, provider)?.authless === true;
  }

  isFreeProviderModel(model: string, provider: string): boolean {
    return this.providerModelConfig(model, provider)?.free === true;
  }

  allModels(): string[] {
    return [...this.effective.entries()]
      .filter(([, info]) => info.providers.length > 0)
      .map(([model]) => model)
      .sort((a, b) => a.localeCompare(b));
  }

  modelsForProvider(provider: string): string[] {
    const values: string[] = [];
    for (const [model, info] of this.effective) {
      if (info.providers.includes(provider)) values.push(model);
    }
    return uniqueSorted(values);
  }

  modelInfo(model: string): ModelInfo | null {
    return this.effective.get(this.resolveAlias(model)) ?? null;
  }

  modelFamily(model: string): string {
    return this.modelInfo(model)?.family ?? "";
  }

  modelCost(model: string): ModelCost | null {
    return this.modelInfo(model)?.cost ?? null;
  }

  entries(): Record<string, ModelInfo> {
    const out: Record<string, ModelInfo> = {};
    for (const [modelId, info] of this.effective) out[modelId] = info;
    return out;
  }

  ignoredModels(): string[] {
    return [...this.ignored].sort((a, b) => a.localeCompare(b));
  }

  families(): string[] {
    const families = new Set<string>();
    for (const info of this.effective.values()) {
      if (info.family) families.add(info.family);
    }
    return [...families].sort((a, b) => a.localeCompare(b));
  }
}
