import { getAuthlessProviderModels } from "./models.js";

export const AUTHLESS_PROVIDER_KEYS = ["opencode", "mimo_code"] as const;

const AUTHLESS_PROVIDER_SET = new Set<string>(AUTHLESS_PROVIDER_KEYS);

export function isAuthlessProvider(provider: string): boolean {
  return AUTHLESS_PROVIDER_SET.has(provider);
}

export function getAuthlessProviderAccounts() {
  const providerModelAuthlessAccounts = Object.entries(getAuthlessProviderModels()).map(([provider, models]) => ({
    id: `authless:${provider}`,
    provider,
    name: provider === "kilo_code" ? "Kilo Code" : provider === "mimo_code" ? "MiMo Code" : provider,
    email: null,
    isActive: true,
    disabledUntil: null as Date | null,
    disabledModels: [] as string[],
    supportedModels: models,
  }));

  return [
    ...AUTHLESS_PROVIDER_KEYS.map((provider) => {
      const label =
        provider === "opencode" ? "Opencode" : provider === "mimo_code" ? "MiMo Code" : provider;
      return {
        id: provider,
        provider,
        name: label,
        email: null,
        isActive: true,
        disabledUntil: null as Date | null,
        disabledModels: [] as string[],
        supportedModels: null as string[] | null,
      };
    }),
    ...providerModelAuthlessAccounts,
  ];
}

export function isSyntheticAuthlessAccount(accountId: string): boolean {
  return isAuthlessProvider(accountId) || accountId.startsWith("authless:");
}
