export const AUTHLESS_PROVIDER_KEYS = ["opencode"] as const;

const AUTHLESS_PROVIDER_SET = new Set<string>(AUTHLESS_PROVIDER_KEYS);

export function isAuthlessProvider(provider: string): boolean {
  return AUTHLESS_PROVIDER_SET.has(provider);
}

export function getAuthlessProviderAccounts() {
  return AUTHLESS_PROVIDER_KEYS.map((provider) => ({
    id: provider,
    provider,
    name: "OpenCode",
    email: null,
    disabledModels: [] as string[],
  }));
}
