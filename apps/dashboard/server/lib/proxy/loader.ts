/**
 * Model registry consumed by the proxy layer.
 *
 * JSON model files are statically imported by the bundler so Cloudflare Workers
 * never need runtime filesystem access.
 */
export interface ModelMeta {
  reasoning?: boolean;
  toolCall?: boolean;
  vision?: boolean;
  modalities?: {
    input: string[];
    output: string[];
  };
}

export interface ModelInfo {
  id?: string;
  providers: string[];
  aliases?: string[];
  description?: string;
  /** Model family name (e.g. "Claude", "OpenAI"). */
  family?: string;
  ignored?: boolean;
  meta?: ModelMeta;
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

export { MODEL_REGISTRY, IGNORED_MODELS } from "virtual:opendum-model-registry";
