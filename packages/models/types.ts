/**
 * Model registry data shapes.
 *
 * These describe the JSON files under `data/` and the derived index used by
 * the refresh scripts.
 */

interface ModelModalities {
  input: string[];
  output: string[];
}

interface ModelLimit {
  context?: number;
  output?: number;
}

interface ModelCost {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ProviderModelConfig {
  upstream?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  authless?: boolean;
  free?: boolean;
  minTier?: string;
  allowedTiers?: string[];
  aliases?: string[];
  [key: string]: unknown;
}

export interface ArtificialAnalysisScores {
  index?: number;
  estimated?: boolean;
}

export interface ModelScores {
  artificialAnalysis?: ArtificialAnalysisScores;
}

export interface ModelData {
  id?: string;
  providers?: string[];
  aliases?: string[];
  description?: string;
  ignored?: boolean;
  reasoning?: boolean;
  reasoning_effort?: string[];
  modalities?: ModelModalities;
  limit?: ModelLimit;
  cost?: ModelCost;
  scores?: ModelScores;
  providerConfig?: Record<string, ProviderModelConfig>;
  family?: string;
  [key: string]: unknown;
}

export interface ModelIndexEntry {
  id: string;
  fileId: string;
  relativeId: string;
  path: string;
  generatedPath?: string;
  modelsDir: string;
  generatedDir: string;
  data: ModelData;
}

export type ModelIndex = Record<string, ModelIndexEntry>;

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
