// GitHub Copilot OAuth and API constants

// OAuth App client id (matches OpenCode)
export const CLIENT_ID = "Ov23li8tweQw6odWQebz";

// OAuth endpoints (GitHub device flow)
export const DEVICE_CODE_ENDPOINT =
  "https://github.com/login/device/code";
export const TOKEN_ENDPOINT =
  "https://github.com/login/oauth/access_token";

// Basic user identity endpoint
export const USER_ENDPOINT = "https://api.github.com/user";

// OAuth scope
export const SCOPE = "read:user";

// Keep Copilot request headers aligned with OpenCode plugin behavior.
export const USER_AGENT = "opencode/1.1.65";

// Polling defaults
export const POLLING_INTERVAL = 5;
export const DEVICE_CODE_EXPIRY = 900;

// Refresh buffer for expiring OAuth tokens
export const REFRESH_BUFFER_SECONDS = 5 * 60;
