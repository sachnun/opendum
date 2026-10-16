export const AUTHLESS = ["opencode"];

export function isAuthless(provider: string): boolean {
  return AUTHLESS.includes(provider);
}

export function isAuthlessId(accountId: string): boolean {
  return AUTHLESS.includes(accountId) || accountId.startsWith("authless:");
}
