import "../../../types/model-registry.d.ts";
import type { ModelModalities } from "../../../lib/model-capabilities";
import type { ModelCost } from "../../../lib/model-cost";
/**
 * Model registry consumed by the proxy layer.
 *
 * JSON model files are statically imported by the bundler so the server runtime
 * never needs filesystem access.
 */
export interface ModelInfo {
  id?: string;
  providers: string[];
  aliases?: string[];
  description?: string;
  /** Model family name (e.g. "Anthropic", "OpenAI"). */
  family?: string;
  ignored?: boolean;
  reasoning?: boolean;
  modalities?: ModelModalities;
  cost?: ModelCost;
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
