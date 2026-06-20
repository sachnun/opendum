import "../../../types/model-registry.d.ts";
import type { ModelMeta } from "../../../lib/model-capabilities";
/**
 * Model registry consumed by the proxy layer.
 *
 * JSON model files are statically imported by the bundler so the server runtime
 * never needs filesystem access.
 */
export type { ModelMeta };

export interface ModelInfo {
  id?: string;
  providers: string[];
  aliases?: string[];
  description?: string;
  /** Model family name (e.g. "Anthropic", "OpenAI"). */
  family?: string;
  ignored?: boolean;
  meta?: ModelMeta;
  providerConfig?: Record<
    string,
    {
      upstream?: string;
      minTier?: string;
      allowedTiers?: string[];
      aliases?: string[];
      [key: string]: unknown;
    }
  >;
}

export { MODEL_REGISTRY, IGNORED_MODELS } from "virtual:opendum-model-registry";
