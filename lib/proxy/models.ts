// Unified Model Registry
// Maps models to their supporting providers

import { ProviderName } from "./providers/types";

/**
 * Model information
 */
export interface ModelInfo {
  providers: string[];
  aliases?: string[];
  description?: string;
}

/**
 * Unified model registry
 * Maps canonical model names to their provider support
 */
export const MODEL_REGISTRY: Record<string, ModelInfo> = {
  // ===== iFlow Models =====
  "glm-4.7": { providers: [ProviderName.IFLOW] },
  "glm-4.6": { providers: [ProviderName.IFLOW] },
  "iflow-rome-30ba3b": { providers: [ProviderName.IFLOW] },
  "minimax-m2.1": { providers: [ProviderName.IFLOW] },
  "minimax-m2": { providers: [ProviderName.IFLOW] },
  "qwen3-coder-plus": { providers: [ProviderName.IFLOW, ProviderName.QWEN_CODE] },
  "kimi-k2": { providers: [ProviderName.IFLOW] },
  "kimi-k2-0905": { providers: [ProviderName.IFLOW] },
  "kimi-k2-thinking": { providers: [ProviderName.IFLOW] },
  "qwen3-max": { providers: [ProviderName.IFLOW] },
  "qwen3-235b-a22b-thinking-2507": { providers: [ProviderName.IFLOW] },
  "deepseek-v3.2-chat": { providers: [ProviderName.IFLOW] },
  "deepseek-v3.2": { providers: [ProviderName.IFLOW] },
  "deepseek-v3.1": { providers: [ProviderName.IFLOW] },
  "deepseek-v3": { providers: [ProviderName.IFLOW] },
  "deepseek-r1": { providers: [ProviderName.IFLOW] },
  "qwen3-vl-plus": { providers: [ProviderName.IFLOW] },
  "qwen3-235b-a22b-instruct": { providers: [ProviderName.IFLOW] },
  "qwen3-235b": { providers: [ProviderName.IFLOW] },

  // ===== Gemini CLI Models =====
  // Gemini 2.5 Pro (exclusive to Gemini CLI)
  "gemini-2.5-pro": { providers: [ProviderName.GEMINI_CLI] },

  // ===== Antigravity + Gemini CLI Shared Models =====
  // Gemini 2.5 Flash variants
  "gemini-2.5-flash": { providers: [ProviderName.ANTIGRAVITY, ProviderName.GEMINI_CLI] },
  "gemini-2.5-flash-thinking": { providers: [ProviderName.ANTIGRAVITY] },
  "gemini-2.5-flash-lite": { providers: [ProviderName.ANTIGRAVITY, ProviderName.GEMINI_CLI] },

  // Gemini 3
  "gemini-3-flash": {
    providers: [ProviderName.ANTIGRAVITY],
  },
  "gemini-3-flash-preview": { providers: [ProviderName.ANTIGRAVITY, ProviderName.GEMINI_CLI] },
  "gemini-3-pro-high": {
    providers: [ProviderName.ANTIGRAVITY],
    aliases: ["gemini-3-pro"],
  },
  "gemini-3-pro-preview": { providers: [ProviderName.ANTIGRAVITY, ProviderName.GEMINI_CLI] },
  "gemini-3-pro-low": { providers: [ProviderName.ANTIGRAVITY] },
  "gemini-3-pro-image": {
    providers: [ProviderName.ANTIGRAVITY],
    aliases: ["gemini-3-pro-image-preview"],
  },

  // ===== Antigravity Exclusive Models =====
  // Claude via Antigravity
  "claude-sonnet-4-5": {
    providers: [ProviderName.ANTIGRAVITY],
    aliases: ["gemini-claude-sonnet-4-5"],
  },
  "claude-sonnet-4-5-thinking": {
    providers: [ProviderName.ANTIGRAVITY],
    aliases: ["gemini-claude-sonnet-4-5-thinking"],
  },
  "claude-opus-4-5": {
    providers: [ProviderName.ANTIGRAVITY],
    aliases: ["gemini-claude-opus-4-5"],
  },
  "claude-opus-4-5-thinking": {
    providers: [ProviderName.ANTIGRAVITY],
    aliases: ["gemini-claude-opus-4-5-thinking"],
  },

  // Other Antigravity models
  "gpt-oss-120b-medium": { providers: [ProviderName.ANTIGRAVITY] },

  // ===== Qwen Code Models =====
  "qwen3-coder-flash": { providers: [ProviderName.QWEN_CODE] },
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
