export const KIRO_REGION = "us-east-1";
export const KIRO_AUTH_ENDPOINT = `https://prod.${KIRO_REGION}.auth.desktop.kiro.dev`;
export const KIRO_AUTHORIZE_ENDPOINT = `${KIRO_AUTH_ENDPOINT}/login`;
export const KIRO_TOKEN_ENDPOINT = `${KIRO_AUTH_ENDPOINT}/oauth/token`;
export const KIRO_REFRESH_ENDPOINT = `${KIRO_AUTH_ENDPOINT}/refreshToken`;
export const KIRO_BROWSER_REDIRECT_URI = "http://localhost:49153/oauth/callback";
export const KIRO_IDP = "Google";
export const KIRO_REFRESH_BUFFER_SECONDS = 5 * 60;

export const CODEX_AUTH_ISSUER = "https://auth.openai.com";
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_AUTHORIZE_ENDPOINT = `${CODEX_AUTH_ISSUER}/oauth/authorize`;
export const CODEX_TOKEN_ENDPOINT = `${CODEX_AUTH_ISSUER}/oauth/token`;
export const CODEX_DEVICE_CODE_ENDPOINT = `${CODEX_AUTH_ISSUER}/api/accounts/deviceauth/usercode`;
export const CODEX_DEVICE_TOKEN_ENDPOINT = `${CODEX_AUTH_ISSUER}/api/accounts/deviceauth/token`;
export const CODEX_DEVICE_REDIRECT_URI = `${CODEX_AUTH_ISSUER}/deviceauth/callback`;
export const CODEX_DEVICE_VERIFICATION_URL = `${CODEX_AUTH_ISSUER}/codex/device`;
export const CODEX_BROWSER_REDIRECT_URI = "http://localhost:1455/auth/callback";
export const CODEX_SCOPE = "openid profile email offline_access";
export const CODEX_ORIGINATOR = "opencode";
export const CODEX_REFRESH_BUFFER_SECONDS = 5 * 60;
export const CODEX_API_BASE_URL = "https://chatgpt.com/backend-api/codex/responses";

export const PERCH_APP_URL = "https://app.perchai.app";
export const PERCH_AUTH_CONFIG_PATH = "/api/perch-terminal/cli-auth/config";
export const PERCH_ACCOUNT_PATH = "/api/perchai/account";
export const PERCH_AUTH_TOKEN_PATH = "/auth/v1/token";
export const PERCH_STARTER_PLAN_CODE = "pilot";
export const PERCH_REDIRECT_URI = "http://127.0.0.1:47321/callback";

export const WORKBUDDY_BASE_URL = "https://www.workbuddy.ai";
export const WORKBUDDY_DOMAIN = "www.workbuddy.ai";

export const CLINE_BASE_URL = "https://api.cline.bot/api/v1";

export const ANTIGRAVITY_GOOGLE_OAUTH_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const ANTIGRAVITY_DEFAULT_PROJECT_ID = "bamboo-precept-lgxtn";
