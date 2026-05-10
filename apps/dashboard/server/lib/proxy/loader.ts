/**
 * Model registry consumed by the proxy layer.
 *
 * JSON model files are statically imported by the bundler so Cloudflare Workers
 * never need runtime filesystem access.
 */
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

const MODEL_MODULES = import.meta.glob<ModelInfo>(
  "../../../../../models/**/*.json",
  {
    eager: true,
    import: "default",
  }
);

function getModelIdFromPath(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1, -".json".length);
}

/** All models loaded from JSON files. */
export const MODEL_REGISTRY: Record<string, ModelInfo> = Object.fromEntries(
  Object.entries(MODEL_MODULES).map(([path, info]) => [getModelIdFromPath(path), info])
);

/** Model IDs marked as ignored (hidden from UI and API). */
export const IGNORED_MODELS: Set<string> = new Set(
  Object.entries(MODEL_REGISTRY)
    .filter(([, info]) => info.ignored)
    .map(([modelId]) => modelId)
);
