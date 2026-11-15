import type { ProviderEntry } from "@opendum/providers/spec";

export const API_BASE_URL = "https://integrate.api.nvidia.com/v1";

export const PROVIDER: ProviderEntry = {
  spec: {
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
  compat: { name: "nvidia_nim", baseUrl: API_BASE_URL },
};
