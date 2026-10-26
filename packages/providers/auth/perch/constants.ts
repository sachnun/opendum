export const PERCH_APP_URL = "https://app.perchai.app";
export const PERCH_CONFIG_PATH = "/api/perch-terminal/cli-auth/config";
export const PERCH_ACCOUNT_PATH = "/api/perchai/account";
export const PERCH_TOKEN_PATH = "/auth/v1/token";
export const PERCH_PLAN_CODE = "pilot";
export const PERCH_REDIRECT_URI = "http://127.0.0.1:47321/callback";

export const PROVIDER = {
  spec: {
    key: "perch" as const,
    slug: "perch",
    label: "Perch",
    category: "oauth" as const,
    showTier: false,
    authMethods: ["oauth_redirect"] as const,
    supportsQuota: true,
    callbackPlaceholder: "http://127.0.0.1:47321/callback?code=...",
    displayOrder: 5,
    navOrder: 5,
  },
};
