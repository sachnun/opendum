import type { ProviderEntry } from "@opendum/providers/core/spec";

export const API_BASE_URL = "https://tokenharbor.ai/v1";

export const PROVIDER: ProviderEntry = {
  spec: {
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
  compat: { name: "harbor", baseUrl: API_BASE_URL },
};
