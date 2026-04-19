// Kiro OAuth and API constants

export const KIRO_REGION = "us-east-1";
export const KIRO_AUTH_SERVICE_ENDPOINT =
  `https://prod.${KIRO_REGION}.auth.desktop.kiro.dev`;
export const KIRO_API_BASE_URL =
  `https://q.${KIRO_REGION}.amazonaws.com/generateAssistantResponse`;

export const KIRO_BROWSER_REDIRECT_URI = "http://localhost:49153/oauth/callback";

export const KIRO_OAUTH_AUTHORIZE_ENDPOINT = `${KIRO_AUTH_SERVICE_ENDPOINT}/login`;
export const KIRO_OAUTH_TOKEN_ENDPOINT = `${KIRO_AUTH_SERVICE_ENDPOINT}/oauth/token`;
export const KIRO_OAUTH_REFRESH_ENDPOINT = `${KIRO_AUTH_SERVICE_ENDPOINT}/refreshToken`;

export const KIRO_OAUTH_IDP = "Google";

export const KIRO_DEFAULT_MODEL = "claude-sonnet-4-5";

export const KIRO_REFRESH_BUFFER_SECONDS = 5 * 60;
