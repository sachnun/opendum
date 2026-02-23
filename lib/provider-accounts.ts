export type ProviderAccountKey =
  | "antigravity"
  | "codex"
  | "copilot"
  | "kiro"
  | "iflow"
  | "gemini_cli"
  | "qwen_code"
  | "nvidia_nim"
  | "ollama_cloud"
  | "openrouter";

export type ProviderAccountCategory = "oauth" | "api_key";

export interface ProviderAccountDefinition {
  key: ProviderAccountKey;
  slug: string;
  label: string;
  category: ProviderAccountCategory;
  description: string;
  emptyMessage: string;
  showTier: boolean;
}

export const PROVIDER_ACCOUNT_DEFINITIONS: ProviderAccountDefinition[] = [
  {
    key: "antigravity",
    slug: "antigravity",
    label: "Antigravity",
    category: "oauth",
    description: "OAuth provider for Gemini and Claude access.",
    emptyMessage: "No Antigravity accounts connected yet.",
    showTier: true,
  },
  {
    key: "codex",
    slug: "codex",
    label: "Codex",
    category: "oauth",
    description: "OAuth provider for GPT-5 Codex accounts.",
    emptyMessage: "No Codex accounts connected yet.",
    showTier: true,
  },
  {
    key: "copilot",
    slug: "copilot",
    label: "Copilot",
    category: "oauth",
    description: "Device-code provider for GitHub Copilot models.",
    emptyMessage: "No Copilot accounts connected yet.",
    showTier: false,
  },
  {
    key: "kiro",
    slug: "kiro",
    label: "Kiro",
    category: "oauth",
    description: "OAuth provider for Claude access via Kiro.",
    emptyMessage: "No Kiro accounts connected yet.",
    showTier: false,
  },
  {
    key: "iflow",
    slug: "iflow",
    label: "Iflow",
    category: "oauth",
    description: "OAuth provider for OpenAI-compatible endpoints.",
    emptyMessage: "No Iflow accounts connected yet.",
    showTier: false,
  },
  {
    key: "gemini_cli",
    slug: "gemini-cli",
    label: "Gemini CLI",
    category: "oauth",
    description: "OAuth provider for Gemini CLI account access.",
    emptyMessage: "No Gemini CLI accounts connected yet.",
    showTier: true,
  },
  {
    key: "qwen_code",
    slug: "qwen-code",
    label: "Qwen Code",
    category: "oauth",
    description: "Device-code provider for Qwen Coder models.",
    emptyMessage: "No Qwen Code accounts connected yet.",
    showTier: false,
  },
  {
    key: "nvidia_nim",
    slug: "nvidia-nim",
    label: "Nvidia",
    category: "api_key",
    description: "API key provider for Nvidia NIM models.",
    emptyMessage: "No Nvidia accounts connected yet.",
    showTier: false,
  },
  {
    key: "ollama_cloud",
    slug: "ollama-cloud",
    label: "Ollama Cloud",
    category: "api_key",
    description: "API key provider for Ollama Cloud endpoints.",
    emptyMessage: "No Ollama Cloud accounts connected yet.",
    showTier: false,
  },
  {
    key: "openrouter",
    slug: "openrouter",
    label: "OpenRouter",
    category: "api_key",
    description: "API key provider for OpenRouter free and paid routes.",
    emptyMessage: "No OpenRouter accounts connected yet.",
    showTier: false,
  },
];

export const PROVIDER_ACCOUNT_BY_KEY: Record<ProviderAccountKey, ProviderAccountDefinition> =
  Object.fromEntries(
    PROVIDER_ACCOUNT_DEFINITIONS.map((definition) => [definition.key, definition])
  ) as Record<ProviderAccountKey, ProviderAccountDefinition>;

export const PROVIDER_ACCOUNT_BY_SLUG: Record<string, ProviderAccountDefinition> =
  Object.fromEntries(
    PROVIDER_ACCOUNT_DEFINITIONS.map((definition) => [definition.slug, definition])
  );

export const OAUTH_PROVIDER_ACCOUNT_DEFINITIONS =
  PROVIDER_ACCOUNT_DEFINITIONS.filter((definition) => definition.category === "oauth");

export const API_KEY_PROVIDER_ACCOUNT_DEFINITIONS =
  PROVIDER_ACCOUNT_DEFINITIONS.filter((definition) => definition.category === "api_key");

export function getProviderAccountPath(provider: ProviderAccountKey): string {
  return `/dashboard/accounts/${PROVIDER_ACCOUNT_BY_KEY[provider].slug}`;
}

export function getProviderFromSlug(providerSlug: string): ProviderAccountKey | null {
  const normalizedSlug = providerSlug.trim().toLowerCase();
  const provider = PROVIDER_ACCOUNT_BY_SLUG[normalizedSlug];
  return provider ? provider.key : null;
}

export function getProviderSuccessMessage(successParam: string): string {
  if (successParam === "antigravity_added") {
    return "Antigravity account connected successfully!";
  }

  if (successParam === "qwen_code_added") {
    return "Qwen Code account connected successfully!";
  }

  if (successParam === "copilot_added") {
    return "Copilot account connected successfully!";
  }

  if (successParam === "gemini_cli_added") {
    return "Gemini CLI account connected successfully!";
  }

  if (successParam === "codex_added") {
    return "Codex account connected successfully!";
  }

  if (successParam === "kiro_added") {
    return "Kiro account connected successfully!";
  }

  if (successParam === "iflow_added") {
    return "Iflow account connected successfully!";
  }

  if (successParam === "nvidia_nim_added") {
    return "Nvidia account connected successfully!";
  }

  if (successParam === "ollama_cloud_added") {
    return "Ollama Cloud account connected successfully!";
  }

  if (successParam === "openrouter_added") {
    return "OpenRouter account connected successfully!";
  }

  return "Account connected successfully!";
}
