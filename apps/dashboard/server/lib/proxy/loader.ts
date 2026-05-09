/**
 * Model registry consumed by the proxy layer.
 *
 * The registry is generated at build time from models/*.toml so Cloudflare
 * Workers never need runtime filesystem access.
 */
import { GENERATED_IGNORED_MODELS, GENERATED_MODEL_REGISTRY } from "./generated-model-registry.js";

export interface ModelMeta {
  contextLength?: number;
  outputLimit?: number;
  knowledgeCutoff?: string;
  releaseDate?: string;
  reasoning?: boolean;
  toolCall?: boolean;
  vision?: boolean;
  modalities?: {
    input: string[];
    output: string[];
  };
}

export interface ModelInfo {
  providers: string[];
  aliases?: string[];
  description?: string;
  /** Model family name (e.g. "Claude", "OpenAI"). Read from [opendum].family in TOML. */
  family?: string;
  meta?: ModelMeta;
  /** Per-provider upstream model name. When absent, the canonical id is used. */
  upstream?: Record<string, string>;
  access?: Record<
    string,
    {
      minTier?: string;
    }
  >;
  providerConfig?: Record<
    string,
    {
      upstream?: string;
      minTier?: string;
      aliases?: string[];
      [key: string]: unknown;
    }
  >;
}

/** All models loaded from TOML files. */
export const MODEL_REGISTRY: Record<string, ModelInfo> = GENERATED_MODEL_REGISTRY;

/** Model IDs marked as ignored (hidden from UI and API). */
export const IGNORED_MODELS: Set<string> = GENERATED_IGNORED_MODELS;
