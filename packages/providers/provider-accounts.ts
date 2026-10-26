type ProviderAccountCategory = "oauth" | "api_key";

export type AuthMethodKey = "oauth_redirect" | "device_code" | "api_key" | "api_key_with_account_id" | "chatgpt_session";

const DEFINITIONS_SOURCE = [
  {
    key: "antigravity",
    slug: "antigravity",
    label: "Antigravity",
    category: "oauth",
    showTier: true,
    authMethods: ["oauth_redirect"],
    supportsQuota: true,
    displayOrder: 0,
    navOrder: 0,
  },
  {
    key: "cline",
    slug: "cline",
    label: "Cline",
    category: "oauth",
    showTier: false,
    authMethods: ["device_code"],
    supportsQuota: false,
    displayOrder: 1,
    navOrder: 1,
  },
  {
    key: "codex",
    slug: "codex",
    label: "Codex",
    category: "oauth",
    showTier: true,
    authMethods: ["oauth_redirect", "device_code", "chatgpt_session"],
    supportsQuota: true,
    callbackPlaceholder: "http://localhost:1455/auth/callback?code=...",
    displayOrder: 2,
    navOrder: 2,
  },
  {
    key: "harbor",
    slug: "harbor",
    label: "Harbor",
    category: "api_key",
    showTier: false,
    authMethods: ["api_key"],
    supportsQuota: false,
    apiKeyPortalUrl: "https://tokenharbor.ai/dashboard",
    apiKeyPlaceholder: "thk_live_...",
    displayOrder: 3,
    navOrder: 3,
  },
  {
    key: "kiro",
    slug: "kiro",
    label: "Kiro",
    category: "oauth",
    showTier: true,
    authMethods: ["oauth_redirect"],
    supportsQuota: true,
    callbackPlaceholder: "http://localhost:49153/oauth/callback?code=...",
    displayOrder: 4,
    navOrder: 4,
  },
  {
    key: "perch",
    slug: "perch",
    label: "Perch",
    category: "oauth",
    showTier: false,
    authMethods: ["oauth_redirect"],
    supportsQuota: true,
    callbackPlaceholder: "http://127.0.0.1:47321/callback?code=...",
    displayOrder: 5,
    navOrder: 5,
  },
  {
    key: "nvidia_nim",
    slug: "nvidia",
    label: "Nvidia",
    category: "api_key",
    showTier: false,
    authMethods: ["api_key"],
    supportsQuota: false,
    apiKeyPortalUrl: "https://build.nvidia.com/settings/api-keys",
    apiKeyPlaceholder: "nvapi-...",
    displayOrder: 7,
    navOrder: 6,
  },
  {
    key: "openrouter",
    slug: "openrouter",
    label: "OpenRouter",
    category: "api_key",
    showTier: false,
    authMethods: ["api_key"],
    supportsQuota: true,
    apiKeyPortalUrl: "https://openrouter.ai/settings/keys",
    apiKeyPlaceholder: "sk-or-v1-...",
    displayOrder: 6,
    navOrder: 7,
  },
  {
    key: "workers_ai",
    slug: "cloudflare",
    label: "Cloudflare",
    category: "api_key",
    showTier: false,
    authMethods: ["api_key_with_account_id"],
    supportsQuota: false,
    apiKeyPortalUrl: "https://dash.cloudflare.com/?to=/:account/ai/workers-ai",
    apiKeyPlaceholder: "Bearer token...",
    accountIdPlaceholder: "e.g. 1a2b3c4d5e6f...",
    accountIdLabel: "Cloudflare Account ID",
    displayOrder: 8,
    navOrder: 10,
  },
  {
    key: "zenmux",
    slug: "zenmux",
    label: "ZenMux",
    category: "api_key",
    showTier: false,
    authMethods: ["api_key"],
    supportsQuota: true,
    apiKeyPortalUrl: "https://zenmux.ai/platform/pay-as-you-go",
    apiKeyPlaceholder: "sk-...",
    displayOrder: 10,
    navOrder: 8,
  },
  {
    key: "workbuddy",
    slug: "workbuddy",
    label: "WorkBuddy",
    category: "oauth",
    showTier: false,
    authMethods: ["device_code"],
    supportsQuota: true,
    displayOrder: 11,
    navOrder: 9,
  },
  {
    key: "hyper",
    slug: "hyper",
    label: "Charm",
    category: "api_key",
    showTier: false,
    authMethods: ["api_key"],
    supportsQuota: true,
    apiKeyPortalUrl: "https://hyper.charm.land",
    apiKeyPlaceholder: "sk-hyper-...",
    displayOrder: 12,
    navOrder: 11,
  },
] as const satisfies readonly {
  key: string;
  slug: string;
  label: string;
  category: ProviderAccountCategory;
  showTier: boolean;
  authMethods: readonly AuthMethodKey[];
  supportsQuota: boolean;
  displayOrder: number;
  navOrder?: number;
  apiKeyPortalUrl?: string;
  apiKeyPlaceholder?: string;
  accountIdLabel?: string;
  accountIdPlaceholder?: string;
  callbackPlaceholder?: string;
}[];

export type ProviderAccountDefinition = (typeof DEFINITIONS_SOURCE)[number] & {
  navOrder?: number;
  displayOrder?: number;
  apiKeyPortalUrl?: string;
  apiKeyPlaceholder?: string;
  accountIdLabel?: string;
  accountIdPlaceholder?: string;
  callbackPlaceholder?: string;
};

export type ProviderAccountKey = (typeof DEFINITIONS_SOURCE)[number]["key"];

export const PROVIDER_ACCOUNT_DEFINITIONS: readonly ProviderAccountDefinition[] = DEFINITIONS_SOURCE;

export const PROVIDER_ACCOUNT_KEYS: readonly ProviderAccountKey[] = DEFINITIONS_SOURCE.map((definition) => definition.key);

export const OAUTH_PROVIDER_KEYS = ["antigravity", "codex", "kiro", "perch"] as const;
export const DEVICE_PROVIDER_KEYS = ["codex", "cline", "workbuddy"] as const;
export const KEY_PROVIDERS = ["nvidia_nim", "openrouter", "zenmux", "harbor", "hyper"] as const;
export const QUOTA_PROVIDER_KEYS = ["antigravity", "codex", "kiro", "perch", "openrouter", "zenmux", "hyper", "workbuddy"] as const;

export type AuthProvider = (typeof OAUTH_PROVIDER_KEYS)[number];
export type DeviceProviderKey = (typeof DEVICE_PROVIDER_KEYS)[number];
export type KeyProvider = (typeof KEY_PROVIDERS)[number];
export type QuotaProviderKey = (typeof QUOTA_PROVIDER_KEYS)[number];

export const BY_KEY: Record<ProviderAccountKey, ProviderAccountDefinition> =
  Object.fromEntries(
    DEFINITIONS_SOURCE.map((definition) => [definition.key, definition])
  ) as Record<ProviderAccountKey, ProviderAccountDefinition>;

const BY_SLUG: Record<string, ProviderAccountDefinition> = Object.fromEntries(
  DEFINITIONS_SOURCE.map((definition) => [definition.slug, definition])
);

export function labelOf(provider: string): string {
  if (provider === "opencode") return "Opencode";
  if (provider === "kilo_code") return "Kilo Code";

  if (provider in BY_KEY) {
    return BY_KEY[provider as ProviderAccountKey].label;
  }

  return provider;
}

export function accountPath(provider: ProviderAccountKey): string {
  return `/${BY_KEY[provider].slug}`;
}

export function hrefMap<V>(
  data: Record<string, V>
): Record<string, V> {
  return Object.fromEntries(
    DEFINITIONS_SOURCE.map((definition) => [
      accountPath(definition.key),
      data[definition.key],
    ])
  ) as Record<string, V>;
}

export function providerOf(providerSlug: string): ProviderAccountKey | null {
  const normalizedSlug = providerSlug.trim().toLowerCase();
  const provider = BY_SLUG[normalizedSlug];
  return provider ? provider.key : null;
}
