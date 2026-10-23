export const CLIENT_ID =
  "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
export const CLIENT_SECRET =
  "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";

export const SCOPES: readonly string[] = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];

export const REDIRECT_URI = "http://localhost:1/oauth2callback";

const CLIENT_METADATA =
  '{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}';
const AUTH_USER_AGENT = "google-api-nodejs-client/10.3.0";
const AUTH_API_CLIENT = "gl-node/22.18.0";

const CODE_ASSIST_ENDPOINT_DAILY =
  "https://daily-cloudcode-pa.googleapis.com";
const CODE_ASSIST_ENDPOINT_PROD = "https://cloudcode-pa.googleapis.com";

export const LOAD_CODE_ASSIST_ENDPOINTS = [
  CODE_ASSIST_ENDPOINT_PROD,
  CODE_ASSIST_ENDPOINT_DAILY,
] as const;

export const ONBOARD_USER_ENDPOINTS = [
  CODE_ASSIST_ENDPOINT_DAILY,
  CODE_ASSIST_ENDPOINT_PROD,
] as const;

export const AUTH_HEADERS = {
  "User-Agent": AUTH_USER_AGENT,
  "X-Goog-Api-Client": AUTH_API_CLIENT,
  "Client-Metadata": CLIENT_METADATA,
} as const;

export const REFRESH_BUFFER_SECONDS = 60 * 60;

export { ANTIGRAVITY_DEFAULT_PROJECT_ID as DEFAULT_PROJECT_ID } from "@opendum/providers/endpoints";
