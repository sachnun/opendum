// Kiro OAuth and API constants

export const REGION = "us-east-1";
const AUTH_ENDPOINT =
  `https://prod.${REGION}.auth.desktop.kiro.dev`;

export const BROWSER_REDIRECT_URI = "http://localhost:49153/oauth/callback";

export const AUTHORIZE_ENDPOINT = `${AUTH_ENDPOINT}/login`;
export const TOKEN_ENDPOINT = `${AUTH_ENDPOINT}/oauth/token`;
export const REFRESH_ENDPOINT = `${AUTH_ENDPOINT}/refreshToken`;

export const IDP = "Google";

export const REFRESH_BUFFER_SECONDS = 5 * 60;
