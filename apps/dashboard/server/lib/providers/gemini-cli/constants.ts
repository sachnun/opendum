// Gemini CLI OAuth and API Constants

// OAuth Configuration (Gemini CLI specific - different from Antigravity)
export const CLIENT_ID =
  "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
export const CLIENT_SECRET =
  "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";

export const SCOPES: readonly string[] = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

// OAuth callback on localhost (user copies URL manually)
export const REDIRECT_URI = "http://localhost:1/oauth2callback";

const VERSION = "0.34.0";
const USER_AGENT_BASE = `GeminiCLI/${VERSION}`;

// API Endpoints (same as Antigravity - both use Google Code Assist)
const CODE_ASSIST_ENDPOINT_DAILY =
  "https://daily-cloudcode-pa.sandbox.googleapis.com";
const CODE_ASSIST_ENDPOINT_PROD = "https://cloudcode-pa.googleapis.com";

export const ENDPOINT_FALLBACKS = [
  CODE_ASSIST_ENDPOINT_DAILY,
  CODE_ASSIST_ENDPOINT_PROD,
] as const;

// Endpoint order for loadCodeAssist (project discovery)
// Production first tends to return better project metadata.
export const LOAD_CODE_ASSIST_ENDPOINTS = [
  CODE_ASSIST_ENDPOINT_PROD,
  CODE_ASSIST_ENDPOINT_DAILY,
] as const;

// Endpoint order for onboardUser (daily first, then production fallback)
export const ONBOARD_USER_ENDPOINTS = [
  CODE_ASSIST_ENDPOINT_DAILY,
  CODE_ASSIST_ENDPOINT_PROD,
] as const;

// Headers for Gemini CLI requests
export const AUTH_HEADERS = {
  "User-Agent": `${USER_AGENT_BASE} (win32; x64)`,
} as const;

// Token refresh buffer (30 minutes before expiry)
export const REFRESH_BUFFER_SECONDS = 30 * 60;
