export const WORKBUDDY_BASE_URL = "https://www.workbuddy.ai";
export const WORKBUDDY_DOMAIN = "www.workbuddy.ai";

export const WORKBUDDY_PLATFORM = "workbuddy-ai";

export const AUTH_STATE_PATH = "/v2/plugin/auth/state";
export const AUTH_TOKEN_PATH = "/v2/plugin/auth/token";
export const LOGIN_ACCOUNT_PATH = "/v2/plugin/login/account";
export const ACCOUNTS_PATH = "/v2/plugin/accounts";

export const PENDING_TOKEN_CODE = 11217;
export const PENDING_ACCOUNT_CODE = 12151;

export const DEVICE_EXPIRY = 300;
export const POLLING_INTERVAL_SECONDS = 1;

export const PROVIDER = {
  spec: {
    key: "workbuddy" as const,
    slug: "workbuddy",
    label: "WorkBuddy",
    category: "oauth" as const,
    showTier: false,
    authMethods: ["device_code"] as const,
    supportsQuota: true,
    displayOrder: 11,
    navOrder: 9,
  },
};
