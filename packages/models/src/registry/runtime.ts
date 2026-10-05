import { inferFamilyFromFolder } from "#models/model/families.ts";

export { loadModelEntries } from "#models/registry/load.ts";
export { suggestionScoreFor } from "#models/registry/suggest.ts";
export { Registry } from "#models/registry/class.ts";

export type ModelModalities = {
  input?: string[];
  output?: string[];
};

export type ModelLimit = {
  context?: number;
  output?: number;
};

export type ModelCost = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
};

export type ProviderAccessRule = {
  minTier?: string;
  allowedTiers?: string[];
};

export type ProviderModelConfig = {
  upstream?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  minTier?: string;
  allowedTiers?: string[];
  authless?: boolean;
  free?: boolean;
  aliases?: string[];
  custom?: Record<string, unknown>;
  [key: string]: unknown;
};

export type ModelScores = {
  artificialAnalysis?: {
    index?: number;
    estimated?: boolean;
    version?: string;
  };
};

export type ModelInfo = {
  id?: string;
  providers: string[];
  aliases?: string[];
  description?: string;
  ignored?: boolean;
  reasoning?: boolean | null;
  reasoning_effort?: string[] | null;
  family?: string;
  owner?: string;
  modalities?: ModelModalities | null;
  limit?: ModelLimit | null;
  cost?: ModelCost | null;
  scores?: ModelScores | null;
  providerConfig?: Record<string, ProviderModelConfig>;
};

export type ModelEntry = {
  fileId: string;
  owner: string;
  info: ModelInfo;
};

export function normalizeProviderAlias(provider: string): string {
  return provider.trim().toLowerCase();
}

export function legacyNvidiaAlias(upstream: string): string {
  const stripped = upstream.startsWith("library/") ? upstream.slice("library/".length) : upstream;
  const replaced = stripped.replace(/[:/]/g, "-").replace(/[^a-zA-Z0-9._-]/g, "-");
  return replaced.replace(/-{2,}/g, "-");
}

export type FlagshipFamily = {
  family: string;
  folder: string;
  score: number;
};

export function flagshipFamilyRanking(entries: ModelEntry[]): FlagshipFamily[] {
  const best = new Map<string, FlagshipFamily>();
  for (const entry of entries) {
    const index = entry.info.scores?.artificialAnalysis?.index;
    if (typeof index !== "number" || !Number.isFinite(index)) continue;
    const family = entry.info.family || inferFamilyFromFolder(entry.owner);
    if (!family) continue;
    const current = best.get(family);
    if (!current || index > current.score) best.set(family, { family, folder: entry.owner || "", score: index });
  }
  return [...best.values()].sort((a, b) => b.score - a.score || a.family.localeCompare(b.family));
}
