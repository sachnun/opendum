export const CLINE_BASE_URL = "https://api.cline.bot/api/v1";

export const WORKOS_BASE_URL = "https://api.workos.com";

export const CLIENT_ID = "client_01K3A541FN8TA3EPPHTD2325AR";

export const DEVICE_AUTHORIZE_PATH = "/user_management/authorize/device";
export const DEVICE_AUTHENTICATE_PATH = "/user_management/authenticate";
export const CLINE_REGISTER_PATH = "/auth/register";

export const DEVICE_EXPIRY = 600;
export const POLLING_INTERVAL_SECONDS = 5;
export const ACCESS_TTL = 3600;

export const PROVIDER = {
  spec: {
    key: "cline" as const,
    slug: "cline",
    label: "Cline",
    category: "oauth" as const,
    showTier: false,
    authMethods: ["device_code"] as const,
    supportsQuota: false,
    displayOrder: 1,
    navOrder: 1,
  },
};
