// Provider registry - factory for getting provider instances

import type { Provider, ProviderNameType } from "./types";
import { ProviderName } from "./types";

// Provider instances will be lazily imported
let iflowProvider: Provider | null = null;
let antigravityProvider: Provider | null = null;
let qwenCodeProvider: Provider | null = null;
let geminiCliProvider: Provider | null = null;
let codexProvider: Provider | null = null;
let nvidiaNimProvider: Provider | null = null;
let ollamaCloudProvider: Provider | null = null;
let openRouterProvider: Provider | null = null;

/**
 * Get a provider instance by name
 */
export async function getProvider(name: ProviderNameType): Promise<Provider> {
  switch (name) {
    case ProviderName.IFLOW:
      if (!iflowProvider) {
        const { iflowProvider: provider } = await import("./iflow");
        iflowProvider = provider;
      }
      return iflowProvider;

    case ProviderName.ANTIGRAVITY:
      if (!antigravityProvider) {
        const { antigravityProvider: provider } = await import("./antigravity");
        antigravityProvider = provider;
      }
      return antigravityProvider;

    case ProviderName.QWEN_CODE:
      if (!qwenCodeProvider) {
        const { qwenCodeProvider: provider } = await import("./qwen-code");
        qwenCodeProvider = provider;
      }
      return qwenCodeProvider;

    case ProviderName.GEMINI_CLI:
      if (!geminiCliProvider) {
        const { geminiCliProvider: provider } = await import("./gemini-cli");
        geminiCliProvider = provider;
      }
      return geminiCliProvider;

    case ProviderName.CODEX:
      if (!codexProvider) {
        const { codexProvider: provider } = await import("./codex");
        codexProvider = provider;
      }
      return codexProvider;

    case ProviderName.NVIDIA_NIM:
      if (!nvidiaNimProvider) {
        const { nvidiaNimProvider: provider } = await import("./nvidia-nim");
        nvidiaNimProvider = provider;
      }
      return nvidiaNimProvider;

    case ProviderName.OLLAMA_CLOUD:
      if (!ollamaCloudProvider) {
        const { ollamaCloudProvider: provider } = await import("./ollama-cloud");
        ollamaCloudProvider = provider;
      }
      return ollamaCloudProvider;

    case ProviderName.OPENROUTER:
      if (!openRouterProvider) {
        const { openRouterProvider: provider } = await import("./openrouter");
        openRouterProvider = provider;
      }
      return openRouterProvider;

    default:
      throw new Error(`Unknown provider: ${name}`);
  }
}

/**
 * Get all available providers
 */
export async function getAllProviders(): Promise<Provider[]> {
  const [iflow, antigravity, qwenCode, geminiCli, codex, nvidiaNim, ollamaCloud, openRouter] = await Promise.all([
    getProvider(ProviderName.IFLOW),
    getProvider(ProviderName.ANTIGRAVITY),
    getProvider(ProviderName.QWEN_CODE),
    getProvider(ProviderName.GEMINI_CLI),
    getProvider(ProviderName.CODEX),
    getProvider(ProviderName.NVIDIA_NIM),
    getProvider(ProviderName.OLLAMA_CLOUD),
    getProvider(ProviderName.OPENROUTER),
  ]);
  return [iflow, antigravity, qwenCode, geminiCli, codex, nvidiaNim, ollamaCloud, openRouter];
}

/**
 * Check if a provider name is valid
 */
export function isValidProvider(name: string): name is ProviderNameType {
  return Object.values(ProviderName).includes(name as ProviderNameType);
}
