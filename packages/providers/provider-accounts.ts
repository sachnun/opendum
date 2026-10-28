import type { AuthMethod, ProviderSpec } from "@opendum/providers/core/spec";
import { accountPath, BY_KEY, BY_SLUG, SPECS } from "@opendum/providers/registry-specs";

export type { AuthMethod as AuthMethodKey, ProviderCategory } from "@opendum/providers/core/spec";
export type ProviderAccountDefinition = ProviderSpec;
export type ProviderAccountKey = string;

export const PROVIDER_ACCOUNT_DEFINITIONS: ReadonlyArray<ProviderAccountDefinition> = SPECS;

export const PROVIDER_ACCOUNT_KEYS: ReadonlyArray<ProviderAccountKey> = SPECS.map((spec) => spec.key);

function keysWith(method: AuthMethod): ReadonlyArray<string> {
  return SPECS.filter((spec) => spec.authMethods.includes(method)).map((spec) => spec.key);
}

export const OAUTH_PROVIDER_KEYS: ReadonlyArray<string> = keysWith("oauth_redirect");
export const DEVICE_PROVIDER_KEYS: ReadonlyArray<string> = keysWith("device_code");
export const KEY_PROVIDERS: ReadonlyArray<string> = SPECS.filter(
  (spec) => spec.category === "api_key" && spec.authMethods.includes("api_key")
).map((spec) => spec.key);
export const QUOTA_PROVIDER_KEYS: ReadonlyArray<string> = SPECS.filter(
  (spec) => spec.supportsQuota
).map((spec) => spec.key);

export type AuthProvider = string;
export type DeviceProviderKey = string;
export type KeyProvider = string;
export type QuotaProviderKey = string;

export { accountPath, BY_KEY, BY_SLUG };

export function labelOf(provider: string): string {
  return BY_KEY[provider]?.label ?? provider;
}

export function hrefMap<V>(data: Record<string, V>): Record<string, V> {
  return Object.fromEntries(SPECS.map((spec) => [accountPath(spec.key), data[spec.key]])) as Record<string, V>;
}

export function providerOf(providerSlug: string): string | null {
  return BY_SLUG[providerSlug.trim().toLowerCase()]?.key ?? null;
}
