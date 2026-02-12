import { ProviderName } from "./providers/types";
import {
  NVIDIA_NIM_MODEL_MAP,
  NVIDIA_NIM_MODELS,
} from "./providers/nvidia-nim/constants";
import {
  OLLAMA_CLOUD_MODEL_MAP,
  OLLAMA_CLOUD_MODELS,
} from "./providers/ollama-cloud/constants";
import {
  OPENROUTER_MODEL_MAP,
  OPENROUTER_MODELS,
} from "./providers/openrouter/constants";

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
    providers: [ProviderName.IFLOW, ProviderName.OLLAMA_CLOUD, ProviderName.NVIDIA_NIM],
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
  "glm-5": {
    providers: [ProviderName.OLLAMA_CLOUD],
    meta: {
      contextLength: 202752,
      releaseDate: "2026-02-11",
      reasoning: true,
      toolCall: true,
      vision: false,
    },
  },
  "glm-4.6": {
    providers: [ProviderName.IFLOW, ProviderName.OLLAMA_CLOUD],
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
  "glm-4.5": {
    providers: [ProviderName.IFLOW],
    meta: {
      contextLength: 131072,
      outputLimit: 98304,
      knowledgeCutoff: "2025-04",
      releaseDate: "2025-07-28",
      reasoning: true,
      toolCall: true,
      vision: false,
    },
  },

  // ===== Iflow Internal Models =====
  "iflow-rome-30ba3b": { providers: [ProviderName.IFLOW] },

  // ===== MiniMax Models =====
  "minimax-m2.1": {
    providers: [ProviderName.IFLOW, ProviderName.OLLAMA_CLOUD, ProviderName.NVIDIA_NIM],
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
    providers: [ProviderName.IFLOW, ProviderName.OLLAMA_CLOUD, ProviderName.NVIDIA_NIM],
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
  "qwen2.5-vl-72b-instruct": {
    providers: [ProviderName.IFLOW],
    meta: {
      contextLength: 32768,
      outputLimit: 32768,
      releaseDate: "2025-03-31",
      reasoning: false,
      toolCall: false,
      vision: true,
    },
  },
  "qwen-vl-max": {
    providers: [ProviderName.IFLOW],
    aliases: ["qwen-vl-max-latest"],
    meta: {
      contextLength: 131072,
      outputLimit: 8192,
      knowledgeCutoff: "2024-04",
      releaseDate: "2024-04-08",
      reasoning: false,
      vision: true,
      toolCall: true,
    },
  },

  // ===== Kimi Models (Moonshot AI) =====
  "kimi-k2": {
    providers: [ProviderName.IFLOW, ProviderName.OLLAMA_CLOUD, ProviderName.NVIDIA_NIM],
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
  "kimi-k2.5": {
    providers: [ProviderName.IFLOW, ProviderName.OLLAMA_CLOUD, ProviderName.NVIDIA_NIM],
    meta: {
      contextLength: 262144,
      outputLimit: 262144,
      knowledgeCutoff: "2025-01",
      releaseDate: "2026-01-27",
      reasoning: true,
      toolCall: true,
      vision: true,
      pricing: { input: 0.6, output: 3 },
    },
  },
  "kimi-k2-0905": {
    providers: [ProviderName.IFLOW, ProviderName.NVIDIA_NIM],
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
    providers: [ProviderName.IFLOW, ProviderName.OLLAMA_CLOUD, ProviderName.NVIDIA_NIM],
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
  "deepseek-v3.2-reasoner": {
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
  "deepseek-v3.2": {
    providers: [ProviderName.IFLOW, ProviderName.OLLAMA_CLOUD, ProviderName.NVIDIA_NIM],
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
    providers: [ProviderName.IFLOW, ProviderName.NVIDIA_NIM],
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
    providers: [ProviderName.ANTIGRAVITY, ProviderName.GEMINI_CLI, ProviderName.OLLAMA_CLOUD],
    aliases: ["gemini-3-flash-preview-latest"],
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
  "claude-opus-4-5": {
    providers: [ProviderName.ANTIGRAVITY],
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
  "claude-opus-4-6": {
    providers: [ProviderName.ANTIGRAVITY],
    aliases: ["claude-opus-4.6"],
    meta: {
      contextLength: 1000000,
      outputLimit: 128000,
      knowledgeCutoff: "2025-05",
      releaseDate: "2026-02",
      reasoning: true,
      toolCall: true,
      vision: true,
      pricing: { input: 5, output: 25 },
    },
  },

  // ===== GPT-OSS Models =====
  "gpt-oss-120b-medium": {
    providers: [ProviderName.ANTIGRAVITY, ProviderName.OLLAMA_CLOUD, ProviderName.NVIDIA_NIM],
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

  // ===== OpenRouter Router Models =====
  "openrouter-free": {
    providers: [ProviderName.OPENROUTER],
    description: "OpenRouter router that automatically selects a compatible free model.",
    meta: {
      contextLength: 200000,
      reasoning: true,
      toolCall: true,
      vision: true,
      pricing: { input: 0, output: 0 },
    },
  },

  // ===== Nvidia Models =====
  "nim-llama-3.1-70b-instruct": {
    providers: [ProviderName.NVIDIA_NIM],
    aliases: ["meta/llama-3.1-70b-instruct"],
    meta: {
      contextLength: 131072,
      outputLimit: 4096,
      releaseDate: "2025-07-23",
      reasoning: false,
      toolCall: true,
      vision: false,
    },
  },
  "deepseek-ai-deepseek-coder-6.7b-instruct": { providers: [ProviderName.NVIDIA_NIM], aliases: ["deepseek-ai/deepseek-coder-6.7b-instruct"] },
  "deepseek-ai-deepseek-r1": { providers: [ProviderName.NVIDIA_NIM], aliases: ["deepseek-ai/deepseek-r1"] },
  "deepseek-ai-deepseek-r1-0528": { providers: [ProviderName.NVIDIA_NIM], aliases: ["deepseek-ai/deepseek-r1-0528"] },
  "deepseek-ai-deepseek-v3.1-terminus": { providers: [ProviderName.NVIDIA_NIM], aliases: ["deepseek-ai/deepseek-v3.1-terminus"] },
  "google-codegemma-1.1-7b": { providers: [ProviderName.NVIDIA_NIM], aliases: ["google/codegemma-1.1-7b"] },
  "google-codegemma-7b": { providers: [ProviderName.NVIDIA_NIM], aliases: ["google/codegemma-7b"] },
  "google-gemma-2-27b-it": { providers: [ProviderName.NVIDIA_NIM], aliases: ["google/gemma-2-27b-it"] },
  "google-gemma-2-2b-it": { providers: [ProviderName.NVIDIA_NIM], aliases: ["google/gemma-2-2b-it"] },
  "google-gemma-3-1b-it": { providers: [ProviderName.NVIDIA_NIM], aliases: ["google/gemma-3-1b-it"] },
  "google-gemma-3n-e2b-it": { providers: [ProviderName.NVIDIA_NIM], aliases: ["google/gemma-3n-e2b-it"] },
  "google-gemma-3n-e4b-it": { providers: [ProviderName.NVIDIA_NIM], aliases: ["google/gemma-3n-e4b-it"] },
  "meta-codellama-70b": { providers: [ProviderName.NVIDIA_NIM], aliases: ["meta/codellama-70b"] },
  "meta-llama-3.1-405b-instruct": { providers: [ProviderName.NVIDIA_NIM], aliases: ["meta/llama-3.1-405b-instruct"] },
  "meta-llama-3.2-11b-vision-instruct": { providers: [ProviderName.NVIDIA_NIM], aliases: ["meta/llama-3.2-11b-vision-instruct"] },
  "meta-llama-3.2-1b-instruct": { providers: [ProviderName.NVIDIA_NIM], aliases: ["meta/llama-3.2-1b-instruct"] },
  "meta-llama-3.3-70b-instruct": { providers: [ProviderName.NVIDIA_NIM], aliases: ["meta/llama-3.3-70b-instruct"] },
  "meta-llama-4-maverick-17b-128e-instruct": { providers: [ProviderName.NVIDIA_NIM], aliases: ["meta/llama-4-maverick-17b-128e-instruct"] },
  "meta-llama-4-scout-17b-16e-instruct": { providers: [ProviderName.NVIDIA_NIM], aliases: ["meta/llama-4-scout-17b-16e-instruct"] },
  "meta-llama3-70b-instruct": { providers: [ProviderName.NVIDIA_NIM], aliases: ["meta/llama3-70b-instruct"] },
  "meta-llama3-8b-instruct": { providers: [ProviderName.NVIDIA_NIM], aliases: ["meta/llama3-8b-instruct"] },
  "microsoft-phi-3-medium-128k-instruct": { providers: [ProviderName.NVIDIA_NIM], aliases: ["microsoft/phi-3-medium-128k-instruct"] },
  "microsoft-phi-3-medium-4k-instruct": { providers: [ProviderName.NVIDIA_NIM], aliases: ["microsoft/phi-3-medium-4k-instruct"] },
  "microsoft-phi-3-small-128k-instruct": { providers: [ProviderName.NVIDIA_NIM], aliases: ["microsoft/phi-3-small-128k-instruct"] },
  "microsoft-phi-3-small-8k-instruct": { providers: [ProviderName.NVIDIA_NIM], aliases: ["microsoft/phi-3-small-8k-instruct"] },
  "microsoft-phi-3-vision-128k-instruct": { providers: [ProviderName.NVIDIA_NIM], aliases: ["microsoft/phi-3-vision-128k-instruct"] },
  "microsoft-phi-3.5-moe-instruct": { providers: [ProviderName.NVIDIA_NIM], aliases: ["microsoft/phi-3.5-moe-instruct"] },
  "microsoft-phi-3.5-vision-instruct": { providers: [ProviderName.NVIDIA_NIM], aliases: ["microsoft/phi-3.5-vision-instruct"] },
  "microsoft-phi-4-mini-instruct": { providers: [ProviderName.NVIDIA_NIM], aliases: ["microsoft/phi-4-mini-instruct"] },
  "mistralai-codestral-22b-instruct-v0.1": { providers: [ProviderName.NVIDIA_NIM], aliases: ["mistralai/codestral-22b-instruct-v0.1"] },
  "mistralai-mamba-codestral-7b-v0.1": { providers: [ProviderName.NVIDIA_NIM], aliases: ["mistralai/mamba-codestral-7b-v0.1"] },
  "mistralai-mistral-large-2-instruct": { providers: [ProviderName.NVIDIA_NIM], aliases: ["mistralai/mistral-large-2-instruct"] },
  "mistralai-mistral-small-3.1-24b-instruct-2503": { providers: [ProviderName.NVIDIA_NIM], aliases: ["mistralai/mistral-small-3.1-24b-instruct-2503"] },
  "nvidia-cosmos-nemotron-34b": { providers: [ProviderName.NVIDIA_NIM], aliases: ["nvidia/cosmos-nemotron-34b"] },
  "nvidia-llama-3.1-nemotron-51b-instruct": { providers: [ProviderName.NVIDIA_NIM], aliases: ["nvidia/llama-3.1-nemotron-51b-instruct"] },
  "nvidia-llama-3.1-nemotron-70b-instruct": { providers: [ProviderName.NVIDIA_NIM], aliases: ["nvidia/llama-3.1-nemotron-70b-instruct"] },
  "nvidia-llama-3.1-nemotron-ultra-253b-v1": { providers: [ProviderName.NVIDIA_NIM], aliases: ["nvidia/llama-3.1-nemotron-ultra-253b-v1"] },
  "nvidia-llama-3.3-nemotron-super-49b-v1": { providers: [ProviderName.NVIDIA_NIM], aliases: ["nvidia/llama-3.3-nemotron-super-49b-v1"] },
  "nvidia-llama-3.3-nemotron-super-49b-v1.5": { providers: [ProviderName.NVIDIA_NIM], aliases: ["nvidia/llama-3.3-nemotron-super-49b-v1.5"] },
  "nvidia-llama3-chatqa-1.5-70b": { providers: [ProviderName.NVIDIA_NIM], aliases: ["nvidia/llama3-chatqa-1.5-70b"] },
  "nvidia-nemotron-4-340b-instruct": { providers: [ProviderName.NVIDIA_NIM], aliases: ["nvidia/nemotron-4-340b-instruct"] },
  "nvidia-nvidia-nemotron-nano-9b-v2": { providers: [ProviderName.NVIDIA_NIM], aliases: ["nvidia/nvidia-nemotron-nano-9b-v2"] },
  "qwen-qwen2.5-coder-32b-instruct": { providers: [ProviderName.NVIDIA_NIM], aliases: ["qwen/qwen2.5-coder-32b-instruct"] },
  "qwen-qwen2.5-coder-7b-instruct": { providers: [ProviderName.NVIDIA_NIM], aliases: ["qwen/qwen2.5-coder-7b-instruct"] },
  "qwen-qwen3-235b-a22b": { providers: [ProviderName.NVIDIA_NIM], aliases: ["qwen/qwen3-235b-a22b"] },
  "qwen-qwen3-next-80b-a3b-instruct": { providers: [ProviderName.NVIDIA_NIM], aliases: ["qwen/qwen3-next-80b-a3b-instruct"] },
  "qwen-qwq-32b": { providers: [ProviderName.NVIDIA_NIM], aliases: ["qwen/qwq-32b"] },

  // ===== Ollama Cloud Models =====
  "cogito-2.1-671b": {
    providers: [ProviderName.OLLAMA_CLOUD],
    meta: {
      contextLength: 163840,
      outputLimit: 32000,
      releaseDate: "2025-11-19",
      reasoning: true,
      toolCall: true,
      vision: false,
    },
  },
  "deepseek-v3.1-671b": {
    providers: [ProviderName.OLLAMA_CLOUD],
    meta: {
      contextLength: 163840,
      outputLimit: 163840,
      releaseDate: "2025-08-21",
      reasoning: true,
      toolCall: true,
      vision: false,
    },
  },
  "devstral-2-123b": {
    providers: [ProviderName.OLLAMA_CLOUD, ProviderName.NVIDIA_NIM],
    meta: {
      contextLength: 262144,
      outputLimit: 262144,
      releaseDate: "2025-12-09",
      reasoning: false,
      toolCall: true,
      vision: false,
    },
  },
  "devstral-small-2-24b": {
    providers: [ProviderName.OLLAMA_CLOUD],
    meta: {
      contextLength: 262144,
      outputLimit: 262144,
      releaseDate: "2025-12-09",
      reasoning: false,
      toolCall: true,
      vision: true,
    },
  },
  "gemma3-12b": {
    providers: [ProviderName.OLLAMA_CLOUD, ProviderName.NVIDIA_NIM],
    meta: {
      contextLength: 131072,
      outputLimit: 131072,
      releaseDate: "2024-12-01",
      reasoning: false,
      toolCall: false,
      vision: true,
    },
  },
  "gemma3-27b": {
    providers: [ProviderName.OLLAMA_CLOUD, ProviderName.NVIDIA_NIM],
    meta: {
      contextLength: 131072,
      outputLimit: 131072,
      releaseDate: "2025-07-27",
      reasoning: false,
      toolCall: false,
      vision: true,
    },
  },
  "gemma3-4b": {
    providers: [ProviderName.OLLAMA_CLOUD],
    meta: {
      contextLength: 131072,
      outputLimit: 131072,
      releaseDate: "2024-12-01",
      reasoning: false,
      toolCall: false,
      vision: true,
    },
  },
  "gpt-oss-20b": {
    providers: [ProviderName.OLLAMA_CLOUD],
    meta: {
      contextLength: 131072,
      outputLimit: 32768,
      releaseDate: "2025-08-05",
      reasoning: true,
      toolCall: true,
      vision: false,
    },
  },
  "kimi-k2-1t": {
    providers: [ProviderName.OLLAMA_CLOUD],
    meta: {
      contextLength: 262144,
      outputLimit: 262144,
      knowledgeCutoff: "2024-10",
      releaseDate: "2025-07-11",
      reasoning: false,
      toolCall: true,
      vision: false,
    },
  },
  "ministral-3-14b": {
    providers: [ProviderName.OLLAMA_CLOUD, ProviderName.NVIDIA_NIM],
    meta: {
      contextLength: 262144,
      outputLimit: 128000,
      releaseDate: "2024-12-01",
      reasoning: false,
      toolCall: true,
      vision: true,
    },
  },
  "ministral-3-3b": {
    providers: [ProviderName.OLLAMA_CLOUD],
    meta: {
      contextLength: 262144,
      outputLimit: 128000,
      releaseDate: "2024-10-22",
      reasoning: false,
      toolCall: true,
      vision: true,
    },
  },
  "ministral-3-8b": {
    providers: [ProviderName.OLLAMA_CLOUD],
    meta: {
      contextLength: 262144,
      outputLimit: 128000,
      releaseDate: "2024-12-01",
      reasoning: false,
      toolCall: true,
      vision: true,
    },
  },
  "mistral-large-3-675b": {
    providers: [ProviderName.OLLAMA_CLOUD, ProviderName.NVIDIA_NIM],
    meta: {
      contextLength: 262144,
      outputLimit: 262144,
      releaseDate: "2025-12-02",
      reasoning: false,
      toolCall: true,
      vision: true,
    },
  },
  "nemotron-3-nano-30b": {
    providers: [ProviderName.OLLAMA_CLOUD, ProviderName.NVIDIA_NIM],
    meta: {
      contextLength: 1048576,
      outputLimit: 131072,
      releaseDate: "2025-12-15",
      reasoning: true,
      toolCall: true,
      vision: false,
    },
  },
  "qwen3-coder-480b": {
    providers: [ProviderName.OLLAMA_CLOUD, ProviderName.NVIDIA_NIM],
    meta: {
      contextLength: 262144,
      outputLimit: 65536,
      releaseDate: "2025-07-22",
      reasoning: false,
      toolCall: true,
      vision: false,
    },
  },
  "qwen3-coder-next": {
    providers: [ProviderName.OLLAMA_CLOUD],
    meta: {
      contextLength: 262144,
      outputLimit: 65536,
      releaseDate: "2026-02-02",
      reasoning: false,
      toolCall: true,
      vision: false,
    },
  },
  "qwen3-next-80b": {
    providers: [ProviderName.OLLAMA_CLOUD, ProviderName.NVIDIA_NIM],
    meta: {
      contextLength: 262144,
      outputLimit: 32768,
      releaseDate: "2025-09-15",
      reasoning: true,
      toolCall: true,
      vision: false,
    },
  },
  "qwen3-vl-235b": {
    providers: [ProviderName.OLLAMA_CLOUD],
    meta: {
      contextLength: 262144,
      outputLimit: 32768,
      releaseDate: "2025-09-22",
      reasoning: true,
      toolCall: true,
      vision: true,
    },
  },
  "qwen3-vl-235b-instruct": {
    providers: [ProviderName.OLLAMA_CLOUD],
    meta: {
      contextLength: 262144,
      outputLimit: 131072,
      releaseDate: "2025-09-22",
      reasoning: false,
      toolCall: true,
      vision: true,
    },
  },
  "rnj-1-8b": {
    providers: [ProviderName.OLLAMA_CLOUD],
    meta: {
      contextLength: 32768,
      outputLimit: 4096,
      releaseDate: "2025-12-06",
      reasoning: false,
      toolCall: true,
      vision: false,
    },
  },

  // ===== Codex Models (OpenAI via ChatGPT Plus/Pro) =====
  "gpt-5.3-codex": {
    providers: [ProviderName.CODEX],
    meta: {
      contextLength: 192000,
      outputLimit: 32768,
      releaseDate: "2026-01-01",
      reasoning: true,
      toolCall: true,
      vision: false,
    },
  },
  "gpt-5.2-codex": {
    providers: [ProviderName.CODEX],
    meta: {
      contextLength: 192000,
      outputLimit: 32768,
      releaseDate: "2025-10-01",
      reasoning: true,
      toolCall: true,
      vision: false,
    },
  },
  "gpt-5.2": {
    providers: [ProviderName.CODEX],
    meta: {
      contextLength: 192000,
      outputLimit: 32768,
      releaseDate: "2025-10-01",
      reasoning: true,
      toolCall: true,
      vision: false,
    },
  },
  "gpt-5.1-codex-max": {
    providers: [ProviderName.CODEX],
    meta: {
      contextLength: 192000,
      outputLimit: 32768,
      releaseDate: "2025-07-01",
      reasoning: true,
      toolCall: true,
      vision: false,
    },
  },
  "gpt-5.1-codex": {
    providers: [ProviderName.CODEX],
    meta: {
      contextLength: 192000,
      outputLimit: 32768,
      releaseDate: "2025-07-01",
      reasoning: true,
      toolCall: true,
      vision: false,
    },
  },
  "gpt-5.1-codex-mini": {
    providers: [ProviderName.CODEX],
    meta: {
      contextLength: 192000,
      outputLimit: 32768,
      releaseDate: "2025-07-01",
      reasoning: true,
      toolCall: true,
      vision: false,
    },
  },
};

const STATIC_MODEL_KEYS = new Set(Object.keys(MODEL_REGISTRY));
const STATIC_MODEL_ALIASES = new Set<string>();
for (const info of Object.values(MODEL_REGISTRY)) {
  if (!info.aliases) {
    continue;
  }

  for (const alias of info.aliases) {
    STATIC_MODEL_ALIASES.add(alias);
  }
}

const NVIDIA_NIM_FALLBACK_REGISTRY: Record<string, ModelInfo> = {};
for (const [model, upstreamModel] of Object.entries(NVIDIA_NIM_MODEL_MAP)) {
  if (STATIC_MODEL_KEYS.has(model) || STATIC_MODEL_ALIASES.has(model)) {
    continue;
  }

  NVIDIA_NIM_FALLBACK_REGISTRY[model] = {
    providers: [ProviderName.NVIDIA_NIM],
    aliases: [upstreamModel],
  };
}

const OLLAMA_CLOUD_FALLBACK_REGISTRY: Record<string, ModelInfo> = {};
for (const model of Object.keys(OLLAMA_CLOUD_MODEL_MAP)) {
  if (STATIC_MODEL_KEYS.has(model) || STATIC_MODEL_ALIASES.has(model)) {
    continue;
  }

  OLLAMA_CLOUD_FALLBACK_REGISTRY[model] = {
    providers: [ProviderName.OLLAMA_CLOUD],
  };
}

const OPENROUTER_FALLBACK_REGISTRY: Record<string, ModelInfo> = {};
for (const model of Object.keys(OPENROUTER_MODEL_MAP)) {
  if (STATIC_MODEL_KEYS.has(model) || STATIC_MODEL_ALIASES.has(model)) {
    continue;
  }

  OPENROUTER_FALLBACK_REGISTRY[model] = {
    providers: [ProviderName.OPENROUTER],
  };
}

const EFFECTIVE_MODEL_REGISTRY: Record<string, ModelInfo> = {
  ...MODEL_REGISTRY,
  ...NVIDIA_NIM_FALLBACK_REGISTRY,
  ...OLLAMA_CLOUD_FALLBACK_REGISTRY,
  ...OPENROUTER_FALLBACK_REGISTRY,
};

function toLegacyOpenRouterModelKey(modelId: string): string {
  return modelId
    .replace(/^library\//, "")
    .replace(/[:/]/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-{2,}/g, "-");
}

// Build reverse lookup for aliases
const aliasToCanonical: Record<string, string> = {};
for (const [canonical, info] of Object.entries(EFFECTIVE_MODEL_REGISTRY)) {
  if (info.aliases) {
    for (const alias of info.aliases) {
      aliasToCanonical[alias] = canonical;
    }
  }
}

for (const [canonical, upstreamModel] of Object.entries(OLLAMA_CLOUD_MODEL_MAP)) {
  if (!EFFECTIVE_MODEL_REGISTRY[canonical]) {
    continue;
  }

  if (!aliasToCanonical[upstreamModel]) {
    aliasToCanonical[upstreamModel] = canonical;
  }
}

for (const [canonical, upstreamModel] of Object.entries(NVIDIA_NIM_MODEL_MAP)) {
  if (!EFFECTIVE_MODEL_REGISTRY[canonical]) {
    continue;
  }

  if (!aliasToCanonical[upstreamModel]) {
    aliasToCanonical[upstreamModel] = canonical;
  }
}

for (const [canonical, upstreamModel] of Object.entries(OPENROUTER_MODEL_MAP)) {
  if (!EFFECTIVE_MODEL_REGISTRY[canonical]) {
    continue;
  }

  if (!aliasToCanonical[upstreamModel]) {
    aliasToCanonical[upstreamModel] = canonical;
  }

  const legacyModelKey = toLegacyOpenRouterModelKey(upstreamModel);
  if (!aliasToCanonical[legacyModelKey]) {
    aliasToCanonical[legacyModelKey] = canonical;
  }
}

const canonicalToAliases: Record<string, string[]> = {};
for (const [alias, canonical] of Object.entries(aliasToCanonical)) {
  if (!canonicalToAliases[canonical]) {
    canonicalToAliases[canonical] = [];
  }

  canonicalToAliases[canonical].push(alias);
}

for (const [canonical, aliases] of Object.entries(canonicalToAliases)) {
  canonicalToAliases[canonical] = Array.from(new Set(aliases)).sort((a, b) => a.localeCompare(b));
}

/**
 * Resolve model alias to canonical name
 */
export function resolveModelAlias(model: string): string {
  return aliasToCanonical[model] ?? model;
}

/**
 * Get canonical model key and known aliases for lookups.
 */
export function getModelLookupKeys(model: string): string[] {
  const canonical = resolveModelAlias(model);
  const aliases = canonicalToAliases[canonical] ?? [];
  return [canonical, ...aliases];
}

/**
 * Get providers that support a given model
 */
export function getProvidersForModel(model: string): string[] {
  const canonical = resolveModelAlias(model);
  const info = EFFECTIVE_MODEL_REGISTRY[canonical];

  if (!info) {
    return [];
  }

  return info.providers.filter((provider) => {
    if (provider === ProviderName.OLLAMA_CLOUD) {
      return OLLAMA_CLOUD_MODELS.has(canonical);
    }

    if (provider === ProviderName.NVIDIA_NIM) {
      return NVIDIA_NIM_MODELS.has(canonical);
    }

    if (provider === ProviderName.OPENROUTER) {
      return OPENROUTER_MODELS.has(canonical);
    }

    return true;
  });
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
  return Object.keys(EFFECTIVE_MODEL_REGISTRY).filter(
    (model) => getProvidersForModel(model).length > 0
  );
}

/**
 * Get all supported models including aliases
 */
export function getAllModelsWithAliases(): string[] {
  const models: string[] = [];
  for (const [canonical, info] of Object.entries(EFFECTIVE_MODEL_REGISTRY)) {
    if (getProvidersForModel(canonical).length === 0) {
      continue;
    }

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
  for (const [model, info] of Object.entries(EFFECTIVE_MODEL_REGISTRY)) {
    if (getProvidersForModel(model).includes(provider)) {
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

  for (const [model, info] of Object.entries(EFFECTIVE_MODEL_REGISTRY)) {
    const providers = getProvidersForModel(model);
    if (providers.length === 0) {
      continue;
    }

    const ownedBy = providers.join(",");

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
