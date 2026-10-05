import { loadModelEntries } from "#models/registry/load.ts";
import { makeCandidate, suggestionScore, type SuggestionCandidate } from "#models/registry/suggest.ts";
import { RegistryStore } from "#models/registry/store.ts";
import { type ModelEntry, type ModelInfo } from "#models/registry/runtime.ts";

const SUGGESTION_THRESHOLD = 0.7;

function isReasoning(model: string, info: ModelInfo): boolean {
  if (info.reasoning == null) return true;
  return info.reasoning;
}

function isVision(info: ModelInfo): boolean {
  if (info.modalities == null) return true;
  return (info.modalities.input ?? []).includes("image");
}

export class Registry extends RegistryStore {
  private constructor(entries: ModelEntry[], options: { familyFromFolder?: boolean } = {}) {
    super(entries, options);
  }

  static load(dir: string, options: { familyFromFolder?: boolean } = {}): Registry {
    return new Registry(loadModelEntries(dir), options);
  }

  static fromEntries(entries: ModelEntry[], options: { familyFromFolder?: boolean } = {}): Registry {
    return new Registry(entries, options);
  }

  authlessProviderModels(): Map<string, string[]> {
    const result = new Map<string, string[]>();
    for (const [model, info] of this.effective) {
      for (const provider of info.providers) {
        if (!this.isAuthlessProviderModel(model, provider)) continue;
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

  providerModelMap(provider: string): Map<string, string> {
    const cached = this.providerModelMapCache.get(provider);
    if (cached) return cached;
    const result = new Map<string, string>();
    for (const [canonical, info] of this.effective) {
      if (!info.providers.includes(provider)) continue;
      const upstream = info.providerConfig?.[provider]?.upstream;
      result.set(canonical, upstream && upstream.length > 0 ? upstream : canonical);
    }
    this.providerModelMapCache.set(provider, result);
    return result;
  }

  providerModelSet(provider: string): Set<string> {
    const cached = this.providerModelSetCache.get(provider);
    if (cached) return cached;
    const set = new Set(this.providerModelMap(provider).keys());
    this.providerModelSetCache.set(provider, set);
    return set;
  }

  suggestedModels(
    model: string,
    provider: string | null,
    candidates: string[] | null,
    limit: number
  ): string[] {
    const term = model.trim();
    if (!term || limit <= 0) return [];
    const query = this.newCandidate(term);

    let useProviderPrefix = false;
    let pool: SuggestionCandidate[] = [];
    if (candidates === null) {
      if (provider) {
        const providerCandidates = this.suggestionProviders.get(provider) ?? [];
        if (providerCandidates.length > 0) {
          pool = providerCandidates;
          useProviderPrefix = true;
        }
      }
      if (pool.length === 0) pool = this.suggestionModels;
    } else {
      pool = [...new Set(candidates.filter((value) => value.length > 0))]
        .sort((a, b) => a.localeCompare(b))
        .map((value) => makeCandidate(value));
      useProviderPrefix = provider !== null;
    }

    const matches: Array<{ value: string; score: number }> = [];
    for (const candidate of pool) {
      const score = suggestionScore(query, candidate);
      if (score >= SUGGESTION_THRESHOLD) matches.push({ value: candidate.value, score });
    }
    matches.sort((a, b) => (a.score === b.score ? a.value.localeCompare(b.value) : b.score - a.score));

    const result: string[] = [];
    const seen = new Set<string>();
    for (const match of matches) {
      const value = useProviderPrefix && provider ? `${provider}/${match.value}` : match.value;
      if (seen.has(value)) continue;
      seen.add(value);
      result.push(value);
      if (result.length >= limit) break;
    }
    return result;
  }

  formatModelsForOpenAI(): Array<Record<string, unknown>> {
    const data: Array<Record<string, unknown>> = [];
    for (const model of this.allModels()) {
      const info = this.effective.get(model) as ModelInfo;
      const item: Record<string, unknown> = {
        id: model,
        object: "model",
        providers: info.providers,
      };
      if (info.owner) item.owner = info.owner;
      const reasoning = isReasoning(model, info);
      item.reasoning = reasoning;
      if (reasoning && (info.reasoning_effort ?? []).length > 0) {
        item.reasoning_effort = info.reasoning_effort;
      }
      if (info.modalities != null) item.modalities = info.modalities;
      if (info.limit != null && ((info.limit.context ?? 0) > 0 || (info.limit.output ?? 0) > 0)) {
        item.limit = info.limit;
      }
      data.push(item);
    }
    return data;
  }

  isReasoningModel(model: string): boolean {
    const info = this.modelInfo(model);
    if (!info) return false;
    return isReasoning(model, info);
  }

  isVisionModel(model: string): boolean {
    const info = this.modelInfo(model);
    if (!info) return false;
    return isVision(info);
  }
}
