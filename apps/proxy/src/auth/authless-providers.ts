export const authlessProviderNames = ["opencode", "mimo_code"];

export function isAuthlessProvider(provider: string): boolean {
  return authlessProviderNames.includes(provider);
}
