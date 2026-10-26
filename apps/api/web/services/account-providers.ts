import { PROVIDER_ACCOUNT_KEYS, type ProviderAccountKey } from "@opendum/providers/provider-accounts";

export { PROVIDER_ACCOUNT_KEYS, type ProviderAccountKey };

const VALID_PROVIDER_KEYS = new Set<string>(PROVIDER_ACCOUNT_KEYS);

export function isKnown(provider: string): provider is ProviderAccountKey {
  return VALID_PROVIDER_KEYS.has(provider);
}
