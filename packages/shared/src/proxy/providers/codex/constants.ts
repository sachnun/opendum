// Codex Provider Constants
// Based on OpenCode's codex plugin: https://github.com/anomalyco/opencode
// Uses Device Code Flow for OAuth via auth.openai.com

// OAuth Configuration
export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const AUTH_ISSUER = "https://auth.openai.com";
export const AUTHORIZE_ENDPOINT = `${AUTH_ISSUER}/oauth/authorize`;
export const BROWSER_REDIRECT_URI = "http://localhost:1455/auth/callback";
export const SCOPE = "openid profile email offline_access";

// OAuth Endpoints
export const DEVICE_CODE_ENDPOINT =
  "https://auth.openai.com/api/accounts/deviceauth/usercode";
export const DEVICE_POLL_ENDPOINT =
  "https://auth.openai.com/api/accounts/deviceauth/token";
export const TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";
export const DEVICE_VERIFICATION_URL =
  "https://auth.openai.com/codex/device";
// Device-code specific redirect URI (used when exchanging authorization_code)
export const REDIRECT_URI =
  "https://auth.openai.com/deviceauth/callback";

// API Endpoint (Responses API format)
export const API_BASE_URL =
  "https://chatgpt.com/backend-api/codex/responses";

// Supported parameters for Responses API requests
export const SUPPORTED_PARAMS = new Set([
  "model",
  "instructions",
  "store",
  "input",
  "stream",
  "tools",
  "tool_choice",
  "reasoning",
  "include",
  "previous_response_id",
]);

// Token refresh buffer (5 minutes before expiry)
export const REFRESH_BUFFER_SECONDS = 5 * 60;

// Device code polling interval (seconds)
export const POLLING_INTERVAL = 5;

// Device code expiry timeout (seconds)
export const DEVICE_CODE_EXPIRY = 600; // 10 minutes

// Originator header value (identifies us to the API)
export const ORIGINATOR = "opencode";
