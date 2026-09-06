import { PROVIDER_ACCOUNT_KEYS, type ProviderAccountKey } from "../../lib/provider-accounts";

export { PROVIDER_ACCOUNT_KEYS, type ProviderAccountKey };

const VALID_PROVIDER_KEYS = new Set<string>(PROVIDER_ACCOUNT_KEYS);

export function isKnownProvider(provider: string): provider is ProviderAccountKey {
  return VALID_PROVIDER_KEYS.has(provider);
}
