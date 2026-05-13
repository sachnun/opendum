import { getAuthlessProviderModels } from "./models.js";

export const AUTHLESS_PROVIDER_KEYS = ["opencode"] as const;

const AUTHLESS_PROVIDER_SET = new Set<string>(AUTHLESS_PROVIDER_KEYS);

export function isAuthlessProvider(provider: string): boolean {
  return AUTHLESS_PROVIDER_SET.has(provider);
}

export function getAuthlessProviderAccounts() {
  const providerModelAuthlessAccounts = Object.entries(getAuthlessProviderModels()).map(([provider, models]) => ({
    id: `authless:${provider}`,
    provider,
    name: provider === "kilo_code" ? "Kilo Code" : provider,
    email: null,
    disabledModels: [] as string[],
    supportedModels: models,
  }));

  return [
    ...AUTHLESS_PROVIDER_KEYS.map((provider) => ({
      id: provider,
      provider,
      name: "OpenCode",
      email: null,
      disabledModels: [] as string[],
      supportedModels: null as string[] | null,
    })),
    ...providerModelAuthlessAccounts,
  ];
}

export function isSyntheticAuthlessAccount(accountId: string): boolean {
  return isAuthlessProvider(accountId) || accountId.startsWith("authless:");
}
