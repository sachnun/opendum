import { authlessModels } from "@opendum/api/web/lib/proxy/models";

export const AUTHLESS_PROVIDER_KEYS = ["opencode"] as const;

const AUTHLESS_PROVIDER_SET = new Set<string>(AUTHLESS_PROVIDER_KEYS);

export function authlessAccounts() {
  const authlessByProvider = Object.entries(authlessModels()).map(([provider, models]) => ({
    id: `authless:${provider}`,
    provider,
    name: provider === "kilo_code" ? "Kilo Code" : provider,
    email: null,
    isActive: true,
    disabledUntil: null as Date | null,
    disabledModels: [] as string[],
    supportedModels: models,
  }));

  return [
    ...AUTHLESS_PROVIDER_KEYS.map((provider) => {
      const label = provider === "opencode" ? "Opencode" : provider;
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
    ...authlessByProvider,
  ];
}

export function isSynthetic(accountId: string): boolean {
  return AUTHLESS_PROVIDER_SET.has(accountId) || accountId.startsWith("authless:");
}
