import { ProviderName } from "./providers/types";

/**
 * Model metadata from models.dev
 */
export interface ModelMeta {
  contextLength?: number;      // max input tokens
  outputLimit?: number;        // max output tokens
  knowledgeCutoff?: string;    // e.g. "2025-04"
  releaseDate?: string;        // e.g. "2025-01-15"
  reasoning?: boolean;         // has reasoning capability
  toolCall?: boolean;          // supports function calling
  vision?: boolean;            // supports image input
  pricing?: {
    input: number;             // $ per 1M tokens
    output: number;
  };
}

/**
 * Model information
 */
export interface ModelInfo {
  providers: string[];
  aliases?: string[];
  description?: string;
  meta?: ModelMeta;
}

/**
 * Unified model registry
 * Maps canonical model names to their provider support
 */
export const MODEL_REGISTRY: Record<string, ModelInfo> = {
  // ===== GLM Models (Zhipu AI) =====
  "glm-4.7": {
    providers: [ProviderName.IFLOW],
    meta: {
      contextLength: 204800,
      outputLimit: 131072,
      knowledgeCutoff: "2025-04",
      releaseDate: "2025-12-22",
      reasoning: true,
      toolCall: true,
      vision: false,
      pricing: { input: 0.27, output: 1.1 },
    },
  },
  "glm-4.6": {
    providers: [ProviderName.IFLOW],
    meta: {
      contextLength: 204800,
      outputLimit: 131072,
      knowledgeCutoff: "2025-04",
      releaseDate: "2025-09-30",
      reasoning: true,
      toolCall: true,
      vision: false,
      pricing: { input: 0.6, output: 2.2 },
    },
  },

  // ===== Iflow Internal Models =====
  "iflow-rome-30ba3b": { providers: [ProviderName.IFLOW] },

  // ===== MiniMax Models =====
  "minimax-m2.1": {
    providers: [ProviderName.IFLOW],
    meta: {
      contextLength: 204800,
      outputLimit: 131072,
      releaseDate: "2025-12-23",
      reasoning: true,
      toolCall: true,
      vision: false,
    },
  },
  "minimax-m2": {
    providers: [ProviderName.IFLOW],
    meta: {
      contextLength: 196608,
      outputLimit: 128000,
      releaseDate: "2025-10-27",
      reasoning: true,
      toolCall: true,
      vision: false,
    },
  },

  // ===== Qwen Models (Alibaba) =====
  "qwen3-coder-plus": {
    providers: [ProviderName.IFLOW, ProviderName.QWEN_CODE],
    meta: {
      contextLength: 256000,
      outputLimit: 64000,
      knowledgeCutoff: "2025-04",
      releaseDate: "2025-07-01",
      reasoning: false,
      toolCall: true,
      vision: false,
    },
  },
  "qwen3-coder-flash": {
    providers: [ProviderName.QWEN_CODE],
    meta: {
      contextLength: 1000000,
      outputLimit: 65536,
      knowledgeCutoff: "2025-04",
      releaseDate: "2025-07-28",
      reasoning: false,
      toolCall: true,
      vision: false,
      pricing: { input: 0.144, output: 0.574 },
    },
  },
  "qwen3-max": {
    providers: [ProviderName.IFLOW],
    meta: {
      contextLength: 256000,
      outputLimit: 32000,
      knowledgeCutoff: "2024-12",
      releaseDate: "2025-01-01",
      reasoning: false,
      toolCall: true,
      vision: false,
    },
  },
  "qwen3-235b-a22b-thinking-2507": {
    providers: [ProviderName.IFLOW],
    meta: {
      contextLength: 262144,
      outputLimit: 262144,
      knowledgeCutoff: "2025-04",
      releaseDate: "2025-07-30",
      reasoning: true,
      toolCall: true,
      vision: false,
      pricing: { input: 0.28, output: 2.8 },
    },
  },
  "qwen3-235b-a22b-instruct": {
    providers: [ProviderName.IFLOW],
    meta: {
      contextLength: 256000,
      outputLimit: 64000,
      knowledgeCutoff: "2025-04",
      releaseDate: "2025-07-01",
      reasoning: false,
      toolCall: true,
      vision: false,
    },
  },
  "qwen3-235b": {
    providers: [ProviderName.IFLOW],
    meta: {
      contextLength: 128000,
      outputLimit: 32000,
      knowledgeCutoff: "2024-10",
      releaseDate: "2024-12-01",
      reasoning: true,
      toolCall: true,
      vision: false,
    },
  },
  "qwen3-vl-plus": {
    providers: [ProviderName.IFLOW],
    meta: {
      contextLength: 256000,
      outputLimit: 32000,
      knowledgeCutoff: "2024-12",
      releaseDate: "2025-01-01",
      reasoning: false,
      toolCall: true,
      vision: true,
    },
  },

  // ===== Kimi Models (Moonshot AI) =====
  "kimi-k2": {
    providers: [ProviderName.IFLOW],
    meta: {
      contextLength: 128000,
      outputLimit: 64000,
      knowledgeCutoff: "2024-10",
      releaseDate: "2024-12-01",
      reasoning: false,
      toolCall: true,
      vision: false,
    },
  },
  "kimi-k2-0905": {
    providers: [ProviderName.IFLOW],
    meta: {
      contextLength: 262144,
      outputLimit: 262144,
      knowledgeCutoff: "2025-06",
      releaseDate: "2025-09-05",
      reasoning: false,
      toolCall: true,
      vision: false,
      pricing: { input: 0.632, output: 2.53 },
    },
  },
  "kimi-k2-thinking": {
    providers: [ProviderName.IFLOW],
    meta: {
      contextLength: 262144,
      outputLimit: 262144,
      knowledgeCutoff: "2024-08",
      releaseDate: "2025-11-06",
      reasoning: true,
      toolCall: true,
      vision: false,
      pricing: { input: 0.6, output: 2.5 },
    },
  },

  // ===== DeepSeek Models =====
  "deepseek-v3.2-chat": {
    providers: [ProviderName.IFLOW],
    aliases: ["deepseek-v3.2-chat"],
    meta: {
      contextLength: 128000,
      outputLimit: 128000,
      knowledgeCutoff: "2024-07",
      releaseDate: "2025-12-01",
      reasoning: true,
      toolCall: true,
      vision: false,
      pricing: { input: 0.58, output: 1.68 },
    },
  },
  "deepseek-v3.2": {
    providers: [ProviderName.IFLOW],
    meta: {
      contextLength: 128000,
      outputLimit: 128000,
      knowledgeCutoff: "2024-07",
      releaseDate: "2025-12-01",
      reasoning: true,
      toolCall: true,
      vision: false,
      pricing: { input: 0.58, output: 1.68 },
    },
  },
  "deepseek-v3.1": {
    providers: [ProviderName.IFLOW],
    meta: {
      contextLength: 131072,
      outputLimit: 131072,
      knowledgeCutoff: "2024-07",
      releaseDate: "2025-08-21",
      reasoning: true,
      toolCall: true,
      vision: false,
      pricing: { input: 0.56, output: 1.68 },
    },
  },
  "deepseek-v3": {
    providers: [ProviderName.IFLOW],
    meta: {
      contextLength: 128000,
      outputLimit: 32000,
      knowledgeCutoff: "2024-10",
      releaseDate: "2024-12-26",
      reasoning: false,
      toolCall: true,
      vision: false,
    },
  },
  "deepseek-r1": {
    providers: [ProviderName.IFLOW],
    meta: {
      contextLength: 163840,
      outputLimit: 163840,
      knowledgeCutoff: "2024-07",
      releaseDate: "2025-01-20",
      reasoning: true,
      toolCall: false,
      vision: false,
      pricing: { input: 1.35, output: 5.4 },
    },
  },

  // ===== Gemini Models (Google) =====
  "gemini-2.5-pro": {
    providers: [ProviderName.GEMINI_CLI],
    meta: {
      contextLength: 2000000,
      outputLimit: 65000,
      knowledgeCutoff: "2025-04",
      releaseDate: "2025-09-15",
      reasoning: true,
      toolCall: true,
      vision: true,
      pricing: { input: 1.25, output: 5 },
    },
  },
  "gemini-2.5-flash": {
    providers: [ProviderName.ANTIGRAVITY, ProviderName.GEMINI_CLI],
    meta: {
      contextLength: 1000000,
      outputLimit: 65000,
      knowledgeCutoff: "2025-04",
      releaseDate: "2025-09-15",
      reasoning: false,
      toolCall: true,
      vision: true,
      pricing: { input: 0.075, output: 0.3 },
    },
  },
  "gemini-2.5-flash-thinking": {
    providers: [ProviderName.ANTIGRAVITY],
    meta: {
      contextLength: 1000000,
      outputLimit: 65000,
      knowledgeCutoff: "2025-04",
      releaseDate: "2025-09-15",
      reasoning: true,
      toolCall: true,
      vision: true,
      pricing: { input: 0.075, output: 0.3 },
    },
  },
  "gemini-2.5-flash-lite": {
    providers: [ProviderName.ANTIGRAVITY, ProviderName.GEMINI_CLI],
    meta: {
      contextLength: 1048576,
      outputLimit: 65536,
      knowledgeCutoff: "2025-01",
      releaseDate: "2025-06-17",
      reasoning: true,
      toolCall: true,
      vision: true,
      pricing: { input: 0.1, output: 0.4 },
    },
  },
  "gemini-3-flash": {
    providers: [ProviderName.ANTIGRAVITY],
    meta: {
      contextLength: 1048576,
      outputLimit: 65536,
      knowledgeCutoff: "2025-01",
      releaseDate: "2025-12-17",
      reasoning: true,
      toolCall: true,
      vision: true,
      pricing: { input: 0.5, output: 3 },
    },
  },
  "gemini-3-flash-preview": {
    providers: [ProviderName.ANTIGRAVITY, ProviderName.GEMINI_CLI],
    meta: {
      contextLength: 1048576,
      outputLimit: 65536,
      knowledgeCutoff: "2025-01",
      releaseDate: "2025-12-17",
      reasoning: true,
      toolCall: true,
      vision: true,
      pricing: { input: 0.5, output: 3 },
    },
  },
  "gemini-3-pro-high": {
    providers: [ProviderName.ANTIGRAVITY],
    aliases: ["gemini-3-pro"],
    meta: {
      contextLength: 1048576,
      outputLimit: 65536,
      knowledgeCutoff: "2025-01",
      releaseDate: "2025-11-18",
      reasoning: true,
      toolCall: true,
      vision: true,
      pricing: { input: 2, output: 12 },
    },
  },
  "gemini-3-pro-preview": {
    providers: [ProviderName.ANTIGRAVITY, ProviderName.GEMINI_CLI],
    meta: {
      contextLength: 1000000,
      outputLimit: 65000,
      knowledgeCutoff: "2025-11",
      releaseDate: "2025-11-19",
      reasoning: true,
      toolCall: true,
      vision: true,
      pricing: { input: 2, output: 12 },
    },
  },
  "gemini-3-pro-low": {
    providers: [ProviderName.ANTIGRAVITY],
    meta: {
      contextLength: 1048576,
      outputLimit: 65536,
      knowledgeCutoff: "2025-01",
      releaseDate: "2025-11-18",
      reasoning: true,
      toolCall: true,
      vision: true,
      pricing: { input: 2, output: 12 },
    },
  },
  "gemini-3-pro-image": {
    providers: [ProviderName.ANTIGRAVITY],
    aliases: ["gemini-3-pro-image-preview"],
    meta: {
      contextLength: 32768,
      outputLimit: 64000,
      knowledgeCutoff: "2025-06",
      releaseDate: "2025-11-20",
      reasoning: false,
      toolCall: false,
      vision: true,
      pricing: { input: 2, output: 120 },
    },
  },

  // ===== Claude Models (Anthropic via Antigravity) =====
  "claude-sonnet-4-5": {
    providers: [ProviderName.ANTIGRAVITY],
    aliases: ["gemini-claude-sonnet-4-5"],
    meta: {
      contextLength: 200000,
      outputLimit: 64000,
      knowledgeCutoff: "2025-07",
      releaseDate: "2025-11-18",
      reasoning: true,
      toolCall: true,
      vision: true,
      pricing: { input: 3, output: 15 },
    },
  },
  "claude-sonnet-4-5-thinking": {
    providers: [ProviderName.ANTIGRAVITY],
    aliases: ["gemini-claude-sonnet-4-5-thinking", "claude-sonnet-4-5-20250929-thinking"],
    meta: {
      contextLength: 200000,
      outputLimit: 64000,
      knowledgeCutoff: "2025-03",
      releaseDate: "2025-09-30",
      reasoning: true,
      toolCall: true,
      vision: true,
      pricing: { input: 3, output: 15 },
    },
  },
  "claude-opus-4-5": {
    providers: [ProviderName.ANTIGRAVITY],
    aliases: ["gemini-claude-opus-4-5"],
    meta: {
      contextLength: 200000,
      outputLimit: 64000,
      knowledgeCutoff: "2025-03",
      releaseDate: "2025-11-24",
      reasoning: true,
      toolCall: true,
      vision: true,
      pricing: { input: 5, output: 25 },
    },
  },
  "claude-opus-4-5-thinking": {
    providers: [ProviderName.ANTIGRAVITY],
    aliases: ["gemini-claude-opus-4-5-thinking", "claude-opus-4-5-20251101-thinking"],
    meta: {
      contextLength: 200000,
      outputLimit: 64000,
      knowledgeCutoff: "2025-03",
      releaseDate: "2025-11-25",
      reasoning: true,
      toolCall: true,
      vision: true,
      pricing: { input: 5, output: 25 },
    },
  },

  // ===== GPT-OSS Models =====
  "gpt-oss-120b-medium": {
    providers: [ProviderName.ANTIGRAVITY],
    aliases: ["gpt-oss-120b"],
    meta: {
      contextLength: 131072,
      outputLimit: 32768,
      releaseDate: "2025-08-05",
      reasoning: true,
      toolCall: true,
      vision: false,
      pricing: { input: 0.25, output: 0.69 },
    },
  },
};

// Build reverse lookup for aliases
const aliasToCanonical: Record<string, string> = {};
for (const [canonical, info] of Object.entries(MODEL_REGISTRY)) {
  if (info.aliases) {
    for (const alias of info.aliases) {
      aliasToCanonical[alias] = canonical;
    }
  }
}

/**
 * Resolve model alias to canonical name
 */
export function resolveModelAlias(model: string): string {
  return aliasToCanonical[model] ?? model;
}

/**
 * Get providers that support a given model
 */
export function getProvidersForModel(model: string): string[] {
  const canonical = resolveModelAlias(model);
  const info = MODEL_REGISTRY[canonical];
  return info?.providers ?? [];
}

/**
 * Check if a model is supported by any provider
 */
export function isModelSupported(model: string): boolean {
  return getProvidersForModel(model).length > 0;
}

/**
 * Check if a model is supported by a specific provider
 */
export function isModelSupportedByProvider(model: string, provider: string): boolean {
  const providers = getProvidersForModel(model);
  return providers.includes(provider);
}

/**
 * Get all supported models (canonical names only)
 */
export function getAllModels(): string[] {
  return Object.keys(MODEL_REGISTRY);
}

/**
 * Get all supported models including aliases
 */
export function getAllModelsWithAliases(): string[] {
  const models: string[] = [];
  for (const [canonical, info] of Object.entries(MODEL_REGISTRY)) {
    models.push(canonical);
    if (info.aliases) {
      models.push(...info.aliases);
    }
  }
  return models;
}

/**
 * Get models for a specific provider
 */
export function getModelsForProvider(provider: string): string[] {
  const models: string[] = [];
  for (const [model, info] of Object.entries(MODEL_REGISTRY)) {
    if (info.providers.includes(provider)) {
      models.push(model);
      if (info.aliases) {
        models.push(...info.aliases);
      }
    }
  }
  return models;
}

/**
 * Format models for OpenAI /v1/models response
 */
export function formatModelsForOpenAI(): Array<{
  id: string;
  object: string;
  created: number;
  owned_by: string;
}> {
  const now = Math.floor(Date.now() / 1000);
  const models: Array<{
    id: string;
    object: string;
    created: number;
    owned_by: string;
  }> = [];

  for (const [model, info] of Object.entries(MODEL_REGISTRY)) {
    const ownedBy = info.providers.join(",");

    // Add canonical name
    models.push({
      id: model,
      object: "model",
      created: now,
      owned_by: ownedBy,
    });

    // Add aliases
    if (info.aliases) {
      for (const alias of info.aliases) {
        models.push({
          id: alias,
          object: "model",
          created: now,
          owned_by: ownedBy,
        });
      }
    }
  }

  return models;
}
