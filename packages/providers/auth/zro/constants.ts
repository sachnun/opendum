import type { ProviderEntry } from "@opendum/providers/core/spec";

export const API_BASE_URL = "https://zro.moonmath.ai/v1";

export const PROVIDER: ProviderEntry = {
  spec: {
    key: "zro",
    slug: "zro",
    label: "Zro",
    category: "api_key",
    showTier: false,
    authMethods: ["api_key"],
    supportsQuota: true,
    apiKeyPortalUrl: "https://zro.moonmath.ai/get-started?plan=free",
    apiKeyPlaceholder: "sk-...",
    displayOrder: 13,
    navOrder: 12,
  },
  compat: { name: "zro", baseUrl: API_BASE_URL },
};
