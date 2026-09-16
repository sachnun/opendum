/**
 * Model registry data shapes.
 *
 * These describe the JSON files under `data/` and the derived index used by
 * the refresh scripts.
 */

export interface ModelModalities {
  input: string[];
  output: string[];
}

export interface ModelLimit {
  context?: number;
  output?: number;
}

export interface ProviderModelConfig {
  upstream?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  authless?: boolean;
  minTier?: string;
  allowedTiers?: string[];
  aliases?: string[];
  [key: string]: unknown;
}

export interface ModelMeta {
  reasoning?: boolean;
  toolCall?: boolean;
  vision?: boolean;
  type?: string;
  code?: boolean;
  tier?: string;
  variant?: string;
  status?: string;
}

export interface ModelData {
  id?: string;
  owner?: string;
  providers?: string[];
  aliases?: string[];
  description?: string;
  ignored?: boolean;
  meta?: ModelMeta;
  modalities?: ModelModalities;
  limit?: ModelLimit;
  providerConfig?: Record<string, ProviderModelConfig>;
  family?: string;
  [key: string]: unknown;
}

export interface ModelIndexEntry {
  id: string;
  fileId: string;
  path: string;
  data: ModelData;
}

export type ModelIndex = Record<string, ModelIndexEntry>;

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
