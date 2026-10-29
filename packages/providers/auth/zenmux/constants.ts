import type { ProviderEntry } from "@opendum/providers/spec";

export const API_BASE_URL = "https://zenmux.ai/api/v1";

export const PROVIDER: ProviderEntry = {
  spec: {
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
  compat: { name: "zenmux", baseUrl: API_BASE_URL },
};
