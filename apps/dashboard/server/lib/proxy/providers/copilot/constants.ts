// GitHub Copilot OAuth and API constants

// OAuth App client id (matches OpenCode)
export const CLIENT_ID = "Ov23li8tweQw6odWQebz";

// OAuth endpoints (GitHub device flow)
export const DEVICE_CODE_ENDPOINT =
  "https://github.com/login/device/code";
export const TOKEN_ENDPOINT =
  "https://github.com/login/oauth/access_token";

// API endpoint (OpenAI-compatible)
export const API_BASE_URL = "https://api.githubcopilot.com";

// Basic user identity endpoint
export const USER_ENDPOINT = "https://api.github.com/user";

// OAuth scope
export const SCOPE = "read:user";

// Supported OpenAI-compatible parameters
export const SUPPORTED_PARAMS = new Set([
  "model",
  "messages",
  "temperature",
  "top_p",
  "max_tokens",
  "stream",
  "tools",
  "tool_choice",
  "presence_penalty",
  "frequency_penalty",
  "n",
  "stop",
  "seed",
  "response_format",
  "reasoning",
  "reasoning_effort",
]);

// Keep Copilot request headers aligned with OpenCode plugin behavior.
export const USER_AGENT = "opencode/1.1.65";
export const INTENT = "conversation-edits";

// Polling defaults
export const POLLING_INTERVAL = 5;
export const DEVICE_CODE_EXPIRY = 900;

// Refresh buffer for expiring OAuth tokens
export const REFRESH_BUFFER_SECONDS = 5 * 60;

// Keep X-Initiator in agent mode for 5 hours per account
export const X_INITIATOR_WINDOW_MS = 5 * 60 * 60 * 1000;
