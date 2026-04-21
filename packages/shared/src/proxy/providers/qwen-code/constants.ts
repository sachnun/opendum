// Qwen Code OAuth and API Constants
// Based on https://github.com/Mirrowel/LLM-API-Key-Proxy

// OAuth Configuration (Device Code Flow)
// Client ID from https://api.kilocode.ai/extension-config.json
export const CLIENT_ID = "f0304373b74a44d2b584a3fb70ca9e56";
export const SCOPE = "openid profile email model.completion";

// OAuth Endpoints
export const TOKEN_ENDPOINT = "https://chat.qwen.ai/api/v1/oauth2/token";
export const DEVICE_CODE_ENDPOINT = "https://chat.qwen.ai/api/v1/oauth2/device/code";

// API Endpoint
export const API_BASE_URL = "https://portal.qwen.ai/v1";

// Supported OpenAI-compatible parameters for Qwen Code API
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
]);

// Token refresh buffer (3 hours before expiry)
export const REFRESH_BUFFER_SECONDS = 3 * 60 * 60;

// Device code polling interval (seconds)
export const POLLING_INTERVAL = 5;

// Device code expiry timeout (seconds)
export const DEVICE_CODE_EXPIRY = 600; // 10 minutes
