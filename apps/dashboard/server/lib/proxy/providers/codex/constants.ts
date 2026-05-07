import os from "node:os";

// Codex Provider Constants
// Based on OpenCode's codex plugin: https://github.com/anomalyco/opencode
// Uses OAuth via auth.openai.com

// OAuth Configuration
export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_ISSUER = "https://auth.openai.com";
export const AUTHORIZE_ENDPOINT = `${AUTH_ISSUER}/oauth/authorize`;
export const BROWSER_REDIRECT_URI = "http://localhost:1455/auth/callback";
export const SCOPE = "openid profile email offline_access";

export const TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";

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
  "parallel_tool_calls",
  "reasoning",
  "include",
  "previous_response_id",
  "prompt_cache_key",
  "client_metadata",
  "service_tier",
]);

// Token refresh buffer (5 minutes before expiry)
export const REFRESH_BUFFER_SECONDS = 5 * 60;

// Originator header value (identifies us to the API)
export const ORIGINATOR = "opencode";

// Match OpenCode's Codex plugin headers.
const OPENCODE_VERSION = "1.14.28";
export const CODEX_CHAT_USER_AGENT = `opencode/${OPENCODE_VERSION} (${os.platform()} ${os.release()}; ${os.arch()})`;
