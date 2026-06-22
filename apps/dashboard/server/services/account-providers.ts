export const PROVIDER_ACCOUNT_KEYS = [
  "antigravity",
  "codex",
  "command_code",
  "kiro",
  "nvidia_nim",
  "openrouter",
  "qoder",
  "siliconflow",
  "workers_ai",
  "zenmux",
] as const;

export type ProviderAccountKey = (typeof PROVIDER_ACCOUNT_KEYS)[number];

const VALID_PROVIDER_KEYS = new Set<string>(PROVIDER_ACCOUNT_KEYS);

export function isKnownProvider(provider: string): provider is ProviderAccountKey {
  return VALID_PROVIDER_KEYS.has(provider);
}
