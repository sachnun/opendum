export const KIRO_REGION = "us-east-1";
export const KIRO_AUTH_ENDPOINT = `https://prod.${KIRO_REGION}.auth.desktop.kiro.dev`;
export const KIRO_AUTHORIZE_ENDPOINT = `${KIRO_AUTH_ENDPOINT}/login`;
export const KIRO_TOKEN_ENDPOINT = `${KIRO_AUTH_ENDPOINT}/oauth/token`;
export const KIRO_REFRESH_ENDPOINT = `${KIRO_AUTH_ENDPOINT}/refreshToken`;
export const KIRO_REDIRECT_URI = "http://localhost:49153/oauth/callback";
export const KIRO_IDP = "Google";
export const KIRO_BUFFER_SECONDS = 5 * 60;

export const AUTHORIZE_ENDPOINT = KIRO_AUTHORIZE_ENDPOINT;
export const BROWSER_REDIRECT_URI = KIRO_REDIRECT_URI;
export const IDP = KIRO_IDP;
export const REFRESH_BUFFER_SECONDS = KIRO_BUFFER_SECONDS;
export const REFRESH_ENDPOINT = KIRO_REFRESH_ENDPOINT;
export const TOKEN_ENDPOINT = KIRO_TOKEN_ENDPOINT;

export const PROVIDER = {
  spec: {
    key: "kiro" as const,
    slug: "kiro",
    label: "Kiro",
    category: "oauth" as const,
    showTier: true,
    authMethods: ["oauth_redirect"] as const,
    supportsQuota: true,
    callbackPlaceholder: "http://localhost:49153/oauth/callback?code=...",
    displayOrder: 4,
    navOrder: 4,
  },
};
