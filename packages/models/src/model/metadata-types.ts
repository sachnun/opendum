import type { IndexedModel } from "#models/model/similarity.ts";
import type { CanonicalIndex } from "#models/model/canonical.ts";

export type RegistryName = "openrouter" | "modelsdev" | "litellm" | "nvidia";

export type Modality = "text" | "image" | "pdf" | "audio" | "video";

export interface Modalities {
  input: Modality[];
  output: Modality[];
}

export interface ProviderLimits {
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface ModelLimit {
  context?: number;
  output?: number;
}

export interface ModelCost {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface RegistryIndex {
  entries: ReadonlyArray<unknown>;
  index: Map<string, IndexedModel<unknown>>;
  byProvider: Record<string, Map<string, IndexedModel<unknown>>>;
}

export type Registries = Partial<Record<RegistryName, RegistryIndex>>;

export interface ExternalCatalogs {
  registries: Registries;
  canonical: CanonicalIndex;
}

export interface ModelMetadataInput {
  id: string;
  candidates: Iterable<string>;
  providers: Iterable<string>;
}

export interface ResolvedHit {
  source: RegistryName;
  id: string;
  entry: unknown;
  provider?: string;
}

export interface ResolvedMetadata {
  perProvider: Record<string, ResolvedHit>;
  global: Partial<Record<RegistryName, ResolvedHit>>;
}

export interface ModelMetadataPatch {
  reasoning: boolean | null;
  reasoningEffort: string[] | null;
  providerLimits: Record<string, ProviderLimits>;
  modalities: Modalities | null;
  limits: ModelLimit;
  cost: ModelCost | null;
  resolvedProviders: number;
  minimumProviderContext: number | null;
  maximumProviderContext: number | null;
}
