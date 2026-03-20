// GitHub Copilot OAuth and API constants

// OAuth App client id (matches OpenCode)
export const COPILOT_CLIENT_ID = "Ov23li8tweQw6odWQebz";

// OAuth endpoints (GitHub device flow)
export const COPILOT_DEVICE_CODE_ENDPOINT =
  "https://github.com/login/device/code";
export const COPILOT_TOKEN_ENDPOINT =
  "https://github.com/login/oauth/access_token";

// API endpoint (OpenAI-compatible)
export const COPILOT_API_BASE_URL = "https://api.githubcopilot.com";

// Basic user identity endpoint
export const COPILOT_USER_ENDPOINT = "https://api.github.com/user";

// OAuth scope
export const COPILOT_SCOPE = "read:user";

// Supported OpenAI-compatible parameters
export const COPILOT_SUPPORTED_PARAMS = new Set([
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
export const COPILOT_OPENCODE_USER_AGENT = "opencode/1.1.65";
export const COPILOT_OPENCODE_INTENT = "conversation-edits";

// Polling defaults
export const COPILOT_POLLING_INTERVAL = 5;
export const COPILOT_DEVICE_CODE_EXPIRY = 900;

// Refresh buffer for expiring OAuth tokens
export const COPILOT_REFRESH_BUFFER_SECONDS = 5 * 60;

// Keep X-Initiator in agent mode for 5 hours per account
export const COPILOT_X_INITIATOR_WINDOW_MS = 5 * 60 * 60 * 1000;
