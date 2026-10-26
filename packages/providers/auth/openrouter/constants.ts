import type { ProviderEntry } from "@opendum/providers/core/spec";

export const API_BASE_URL = "https://openrouter.ai/api/v1";

export const PROVIDER: ProviderEntry = {
  spec: {
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
  compat: { name: "openrouter", baseUrl: API_BASE_URL },
};
