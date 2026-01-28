// Provider registry - factory for getting provider instances

import type { Provider, ProviderNameType } from "./types";
import { ProviderName } from "./types";

// Provider instances will be lazily imported
let iflowProvider: Provider | null = null;
let antigravityProvider: Provider | null = null;
let qwenCodeProvider: Provider | null = null;

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

    default:
      throw new Error(`Unknown provider: ${name}`);
  }
}

/**
 * Get all available providers
 */
export async function getAllProviders(): Promise<Provider[]> {
  const [iflow, antigravity, qwenCode] = await Promise.all([
    getProvider(ProviderName.IFLOW),
    getProvider(ProviderName.ANTIGRAVITY),
    getProvider(ProviderName.QWEN_CODE),
  ]);
  return [iflow, antigravity, qwenCode];
}

/**
 * Check if a provider name is valid
 */
export function isValidProvider(name: string): name is ProviderNameType {
  return Object.values(ProviderName).includes(name as ProviderNameType);
}
