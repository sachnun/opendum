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

    default:
      throw new Error(`Unknown provider: ${name}`);
  }
}

/**
 * Check if a provider name is valid
 */
export function isValidProvider(name: string): name is ProviderNameType {
  return Object.values(ProviderName).includes(name as ProviderNameType);
}
