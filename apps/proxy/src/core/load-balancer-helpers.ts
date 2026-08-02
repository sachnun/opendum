import { isAuthlessProvider } from "../auth/authless-providers.js";

export const providerModelAuthlessAccountPrefix = "authless:";

export function isSyntheticProviderAccountID(accountID: string): boolean {
  return isAuthlessProvider(accountID) || accountID.startsWith(providerModelAuthlessAccountPrefix);
}
