// Provider registry - factory for getting provider instances

import type { Provider, ProviderNameType } from "./types.js";
import { ProviderName } from "./types.js";

// Provider instances will be lazily imported
let antigravityProvider: Provider | null = null;
let copilotProvider: Provider | null = null;
let qwenCodeProvider: Provider | null = null;
let geminiCliProvider: Provider | null = null;
let codexProvider: Provider | null = null;
let kiroProvider: Provider | null = null;
let nvidiaNimProvider: Provider | null = null;
let ollamaCloudProvider: Provider | null = null;
let openRouterProvider: Provider | null = null;
let groqProvider: Provider | null = null;
let cerebrasProvider: Provider | null = null;
let kiloCodeProvider: Provider | null = null;

/**
 * Get a provider instance by name
 */
export async function getProvider(name: ProviderNameType): Promise<Provider> {
  switch (name) {
    case ProviderName.ANTIGRAVITY:
      if (!antigravityProvider) {
        const { antigravityProvider: provider } = await import("./antigravity/index.js");
        antigravityProvider = provider;
      }
      return antigravityProvider;

    case ProviderName.COPILOT:
      if (!copilotProvider) {
        const { copilotProvider: provider } = await import("./copilot/index.js");
        copilotProvider = provider;
      }
      return copilotProvider;

    case ProviderName.QWEN_CODE:
      if (!qwenCodeProvider) {
        const { qwenCodeProvider: provider } = await import("./qwen-code/index.js");
        qwenCodeProvider = provider;
      }
      return qwenCodeProvider;

    case ProviderName.GEMINI_CLI:
      if (!geminiCliProvider) {
        const { geminiCliProvider: provider } = await import("./gemini-cli/index.js");
        geminiCliProvider = provider;
      }
      return geminiCliProvider;

    case ProviderName.CODEX:
      if (!codexProvider) {
        const { codexProvider: provider } = await import("./codex/index.js");
        codexProvider = provider;
      }
      return codexProvider;

    case ProviderName.KIRO:
      if (!kiroProvider) {
        const { kiroProvider: provider } = await import("./kiro/index.js");
        kiroProvider = provider;
      }
      return kiroProvider;

    case ProviderName.NVIDIA_NIM:
      if (!nvidiaNimProvider) {
        const { nvidiaNimProvider: provider } = await import("./nvidia-nim/index.js");
        nvidiaNimProvider = provider;
      }
      return nvidiaNimProvider;

    case ProviderName.OLLAMA_CLOUD:
      if (!ollamaCloudProvider) {
        const { ollamaCloudProvider: provider } = await import("./ollama-cloud/index.js");
        ollamaCloudProvider = provider;
      }
      return ollamaCloudProvider;

    case ProviderName.OPENROUTER:
      if (!openRouterProvider) {
        const { openRouterProvider: provider } = await import("./openrouter/index.js");
        openRouterProvider = provider;
      }
      return openRouterProvider;

    case ProviderName.GROQ:
      if (!groqProvider) {
        const { groqProvider: provider } = await import("./groq/index.js");
        groqProvider = provider;
      }
      return groqProvider;

    case ProviderName.CEREBRAS:
      if (!cerebrasProvider) {
        const { cerebrasProvider: provider } = await import("./cerebras/index.js");
        cerebrasProvider = provider;
      }
      return cerebrasProvider;

    case ProviderName.KILO_CODE:
      if (!kiloCodeProvider) {
        const { kiloCodeProvider: provider } = await import("./kilo-code/index.js");
        kiloCodeProvider = provider;
      }
      return kiloCodeProvider;

    default:
      throw new Error(`Unknown provider: ${name}`);
  }
}

/**
 * Get all available providers
 */
export async function getAllProviders(): Promise<Provider[]> {
  const [antigravity, copilot, qwenCode, geminiCli, codex, kiro, ollamaCloud, openRouter, nvidiaNim, groq, cerebras, kiloCode] = await Promise.all([
    getProvider(ProviderName.ANTIGRAVITY),
    getProvider(ProviderName.COPILOT),
    getProvider(ProviderName.QWEN_CODE),
    getProvider(ProviderName.GEMINI_CLI),
    getProvider(ProviderName.CODEX),
    getProvider(ProviderName.KIRO),
    getProvider(ProviderName.OLLAMA_CLOUD),
    getProvider(ProviderName.OPENROUTER),
    getProvider(ProviderName.NVIDIA_NIM),
    getProvider(ProviderName.GROQ),
    getProvider(ProviderName.CEREBRAS),
    getProvider(ProviderName.KILO_CODE),
  ]);
  return [antigravity, copilot, qwenCode, geminiCli, codex, kiro, ollamaCloud, openRouter, nvidiaNim, groq, cerebras, kiloCode];
}

/**
 * Check if a provider name is valid
 */
export function isValidProvider(name: string): name is ProviderNameType {
  return Object.values(ProviderName).includes(name as ProviderNameType);
}
