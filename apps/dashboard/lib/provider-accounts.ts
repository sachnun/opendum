export type ProviderAccountKey =
  | "antigravity"
  | "codex"
  | "copilot"
  | "gemini_cli"
  | "iflow"
  | "kiro"
  | "nvidia_nim"
  | "ollama_cloud"
  | "openrouter"
  | "qwen_code";

export type ProviderAccountCategory = "oauth" | "api_key";

export interface ProviderAccountDefinition {
  key: ProviderAccountKey;
  slug: string;
  label: string;
  category: ProviderAccountCategory;
  emptyMessage: string;
  showTier: boolean;
}

export const PROVIDER_ACCOUNT_DEFINITIONS: ProviderAccountDefinition[] = [
  {
    key: "antigravity",
    slug: "antigravity",
    label: "Antigravity",
    category: "oauth",
    emptyMessage: "No Antigravity connections yet.",
    showTier: true,
  },
  {
    key: "codex",
    slug: "codex",
    label: "Codex",
    category: "oauth",
    emptyMessage: "No Codex connections yet.",
    showTier: true,
  },
  {
    key: "copilot",
    slug: "copilot",
    label: "Copilot",
    category: "oauth",
    emptyMessage: "No Copilot connections yet.",
    showTier: false,
  },
  {
    key: "gemini_cli",
    slug: "gemini-cli",
    label: "Gemini CLI",
    category: "oauth",
    emptyMessage: "No Gemini CLI connections yet.",
    showTier: true,
  },
  {
    key: "iflow",
    slug: "iflow",
    label: "Iflow",
    category: "oauth",
    emptyMessage: "No Iflow connections yet.",
    showTier: false,
  },
  {
    key: "kiro",
    slug: "kiro",
    label: "Kiro",
    category: "oauth",
    emptyMessage: "No Kiro connections yet.",
    showTier: false,
  },
  {
    key: "qwen_code",
    slug: "qwen-code",
    label: "Qwen Code",
    category: "oauth",
    emptyMessage: "No Qwen Code connections yet.",
    showTier: false,
  },
  {
    key: "nvidia_nim",
    slug: "nvidia-nim",
    label: "Nvidia",
    category: "api_key",
    emptyMessage: "No Nvidia connections yet.",
    showTier: false,
  },
  {
    key: "ollama_cloud",
    slug: "ollama-cloud",
    label: "Ollama Cloud",
    category: "api_key",
    emptyMessage: "No Ollama Cloud connections yet.",
    showTier: false,
  },
  {
    key: "openrouter",
    slug: "openrouter",
    label: "OpenRouter",
    category: "api_key",
    emptyMessage: "No OpenRouter connections yet.",
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

/**
 * Build a Record mapping provider account paths to values from a keyed data object.
 * This avoids manually listing every provider when building href-based lookup maps.
 */
export function buildProviderHrefMap<V>(
  data: Record<ProviderAccountKey, V>
): Record<string, V> {
  return Object.fromEntries(
    PROVIDER_ACCOUNT_DEFINITIONS.map((definition) => [
      getProviderAccountPath(definition.key),
      data[definition.key],
    ])
  ) as Record<string, V>;
}

export function getProviderFromSlug(providerSlug: string): ProviderAccountKey | null {
  const normalizedSlug = providerSlug.trim().toLowerCase();
  const provider = PROVIDER_ACCOUNT_BY_SLUG[normalizedSlug];
  return provider ? provider.key : null;
}

export function getProviderSuccessMessage(successParam: string): string {
  if (successParam === "antigravity_added") {
    return "Antigravity connected successfully!";
  }

  if (successParam === "qwen_code_added") {
    return "Qwen Code connected successfully!";
  }

  if (successParam === "copilot_added") {
    return "Copilot connected successfully!";
  }

  if (successParam === "gemini_cli_added") {
    return "Gemini CLI connected successfully!";
  }

  if (successParam === "codex_added") {
    return "Codex connected successfully!";
  }

  if (successParam === "kiro_added") {
    return "Kiro connected successfully!";
  }

  if (successParam === "iflow_added") {
    return "Iflow connected successfully!";
  }

  if (successParam === "nvidia_nim_added") {
    return "Nvidia connected successfully!";
  }

  if (successParam === "ollama_cloud_added") {
    return "Ollama Cloud connected successfully!";
  }

  if (successParam === "openrouter_added") {
    return "OpenRouter connected successfully!";
  }

  return "Connected successfully!";
}
