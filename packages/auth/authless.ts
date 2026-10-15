export const AUTHLESS_PROVIDER_NAMES = ["opencode"];

export function isAuthlessProvider(provider: string): boolean {
  return AUTHLESS_PROVIDER_NAMES.includes(provider);
}

export function isAuthlessProviderAccountId(accountId: string): boolean {
  return AUTHLESS_PROVIDER_NAMES.includes(accountId) || accountId.startsWith("authless:");
}
