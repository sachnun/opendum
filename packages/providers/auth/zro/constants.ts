import type { ProviderEntry } from "@opendum/providers/core/spec";

export const API_BASE_URL = "https://zro.moonmath.ai/v1";
export const CONTROL_PLANE_URL = "https://zro.moonmath.ai";

export const AUTH_START_PATH = "/api/cli/auth/start";
export const AUTH_TOKEN_PATH = "/api/cli/auth/token";

export const DEVICE_EXPIRY = 600;
export const POLLING_INTERVAL_SECONDS = 2;
export const ACCESS_TTL = 31536000;

export const DEVICE_NAME = "Opendum";

export const PROVIDER: ProviderEntry = {
  spec: {
    key: "zro",
    slug: "zro",
    label: "Zro",
    category: "api_key",
    showTier: false,
    authMethods: ["api_key", "device_code"],
    supportsQuota: true,
    apiKeyPortalUrl: "https://zro.moonmath.ai/get-started?plan=free",
    apiKeyPlaceholder: "sk-...",
    displayOrder: 13,
    navOrder: 12,
  },
  compat: { name: "zro", baseUrl: API_BASE_URL },
};
