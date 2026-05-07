export const PROVIDER_ACCOUNT_KEYS = [
  "antigravity",
  "codex",
  "copilot",
  "gemini_cli",
  "kiro",
  "qwen_code",
  "nvidia_nim",
  "ollama_cloud",
  "openrouter",
  "groq",
  "kilo_code",
  "cerebras",
  "workers_ai",
] as const;

export type ProviderAccountKey = (typeof PROVIDER_ACCOUNT_KEYS)[number];

const VALID_PROVIDER_KEYS = new Set<string>(PROVIDER_ACCOUNT_KEYS);

export function isKnownProvider(provider: string): provider is ProviderAccountKey {
  return VALID_PROVIDER_KEYS.has(provider);
}
