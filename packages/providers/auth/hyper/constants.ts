import type { ProviderEntry } from "@opendum/providers/spec";

export const API_BASE_URL = "https://hyper.charm.land/v1";

export const PROVIDER: ProviderEntry = {
  spec: {
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
  compat: { name: "hyper", baseUrl: API_BASE_URL },
};
