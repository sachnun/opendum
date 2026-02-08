// ChatGPT Codex Provider Constants
// Based on OpenCode's codex plugin: https://github.com/anomalyco/opencode
// Uses Device Code Flow for OAuth via auth.openai.com

// OAuth Configuration (Device Code Flow)
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_AUTH_ISSUER = "https://auth.openai.com";

// OAuth Endpoints
export const CODEX_DEVICE_CODE_ENDPOINT =
  "https://auth.openai.com/api/accounts/deviceauth/usercode";
export const CODEX_DEVICE_POLL_ENDPOINT =
  "https://auth.openai.com/api/accounts/deviceauth/token";
export const CODEX_TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";
export const CODEX_DEVICE_VERIFICATION_URL =
  "https://auth.openai.com/codex/device";
export const CODEX_REDIRECT_URI =
  "https://auth.openai.com/deviceauth/callback";

// API Endpoint (Responses API format)
export const CODEX_API_BASE_URL =
  "https://chatgpt.com/backend-api/codex/responses";

// Supported parameters for Responses API requests
export const CODEX_SUPPORTED_PARAMS = new Set([
  "model",
  "input",
  "instructions",
  "temperature",
  "top_p",
  "max_output_tokens",
  "stream",
  "tools",
  "tool_choice",
  "previous_response_id",
  "reasoning",
  "truncation",
]);

// Available Codex models (from codex-rs/core/models.json)
export const CODEX_MODELS = new Set([
  "gpt-5.3-codex",
  "gpt-5.2-codex",
  "gpt-5.2",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex",
  "gpt-5.1-codex-mini",
]);

// Token refresh buffer (5 minutes before expiry)
export const CODEX_REFRESH_BUFFER_SECONDS = 5 * 60;

// Device code polling interval (seconds)
export const CODEX_POLLING_INTERVAL = 5;

// Device code expiry timeout (seconds)
export const CODEX_DEVICE_CODE_EXPIRY = 600; // 10 minutes

// Originator header value (identifies us to the API)
export const CODEX_ORIGINATOR = "opencode";
