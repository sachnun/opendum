export const CODEX_AUTH_ISSUER = "https://auth.openai.com";
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_AUTHORIZE_ENDPOINT = `${CODEX_AUTH_ISSUER}/oauth/authorize`;
export const CODEX_TOKEN_ENDPOINT = `${CODEX_AUTH_ISSUER}/oauth/token`;
export const CODEX_DEVICE_CODE = `${CODEX_AUTH_ISSUER}/api/accounts/deviceauth/usercode`;
export const CODEX_DEVICE_TOKEN = `${CODEX_AUTH_ISSUER}/api/accounts/deviceauth/token`;
export const CODEX_DEVICE_REDIRECT = `${CODEX_AUTH_ISSUER}/deviceauth/callback`;
export const CODEX_VERIFICATION_URL = `${CODEX_AUTH_ISSUER}/codex/device`;
export const CODEX_REDIRECT_URI = "http://localhost:1455/auth/callback";
export const CODEX_SCOPE = "openid profile email offline_access";
export const CODEX_ORIGINATOR = "opencode";
export const CODEX_BUFFER_SECONDS = 5 * 60;
export const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex/responses";

export const AUTHORIZE_ENDPOINT = CODEX_AUTHORIZE_ENDPOINT;
export const BROWSER_REDIRECT_URI = CODEX_REDIRECT_URI;
export const CLIENT_ID = CODEX_CLIENT_ID;
export const DEVICE_CODE_ENDPOINT = CODEX_DEVICE_CODE;
export const DEVICE_REDIRECT_URI = CODEX_DEVICE_REDIRECT;
export const DEVICE_TOKEN_ENDPOINT = CODEX_DEVICE_TOKEN;
export const DEVICE_VERIFICATION_URL = CODEX_VERIFICATION_URL;
export const ORIGINATOR = CODEX_ORIGINATOR;
export const REFRESH_BUFFER_SECONDS = CODEX_BUFFER_SECONDS;
export const SCOPE = CODEX_SCOPE;
export const TOKEN_ENDPOINT = CODEX_TOKEN_ENDPOINT;

export const PROVIDER = {
  spec: {
    key: "codex" as const,
    slug: "codex",
    label: "Codex",
    category: "oauth" as const,
    showTier: true,
    authMethods: ["oauth_redirect", "device_code", "chatgpt_session"] as const,
    supportsQuota: true,
    callbackPlaceholder: "http://localhost:1455/auth/callback?code=...",
    displayOrder: 2,
    navOrder: 2,
  },
};
