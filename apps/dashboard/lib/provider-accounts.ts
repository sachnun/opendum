export type ProviderAccountKey =
  | "antigravity"
  | "codex"
  | "copilot"
  | "kiro"
  | "nvidia_nim"
  | "openrouter"
  | "qoder"
  | "siliconflow"
  | "workers_ai"
  | "zenmux";

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
    showTier: true,
  },
  {
    key: "kiro",
    slug: "kiro",
    label: "Kiro",
    category: "oauth",
    emptyMessage: "No Kiro connections yet.",
    showTier: true,
  },
  {
    key: "nvidia_nim",
    slug: "nvidia",
    label: "Nvidia",
    category: "api_key",
    emptyMessage: "No Nvidia connections yet.",
    showTier: false,
  },
  {
    key: "openrouter",
    slug: "openrouter",
    label: "Openrouter",
    category: "api_key",
    emptyMessage: "No Openrouter connections yet.",
    showTier: false,
  },
  {
    key: "workers_ai",
    slug: "cloudflare",
    label: "Cloudflare",
    category: "api_key",
    emptyMessage: "No Cloudflare accounts connected yet.",
    showTier: false,
  },
  {
    key: "qoder",
    slug: "qoder",
    label: "Qoder",
    category: "api_key",
    emptyMessage: "No Qoder connections yet.",
    showTier: false,
  },
  {
    key: "zenmux",
    slug: "zenmux",
    label: "ZenMux",
    category: "api_key",
    emptyMessage: "No ZenMux connections yet.",
    showTier: false,
  },
  {
    key: "siliconflow",
    slug: "siliconflow",
    label: "SiliconFlow",
    category: "api_key",
    emptyMessage: "No SiliconFlow connections yet.",
    showTier: false,
  },
];

export const BY_KEY: Record<ProviderAccountKey, ProviderAccountDefinition> =
  Object.fromEntries(
    PROVIDER_ACCOUNT_DEFINITIONS.map((definition) => [definition.key, definition])
  ) as Record<ProviderAccountKey, ProviderAccountDefinition>;

const BY_SLUG: Record<string, ProviderAccountDefinition> = Object.fromEntries(
  PROVIDER_ACCOUNT_DEFINITIONS.map((definition) => [definition.slug, definition])
);

export function getProviderLabel(provider: string): string {
  if (provider === "opencode") return "Opencode";
  if (provider === "kilo_code") return "Kilo Code";
  if (provider === "mimo_code") return "MiMo Code";

  if (provider in BY_KEY) {
    return BY_KEY[provider as ProviderAccountKey].label;
  }

  return provider;
}

export function getProviderAccountPath(provider: ProviderAccountKey): string {
  return `/dashboard/${BY_KEY[provider].slug}`;
}

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
  const provider = BY_SLUG[normalizedSlug];
  return provider ? provider.key : null;
}
