// Iflow OAuth and API Constants
// Based on https://github.com/Mirrowel/LLM-API-Key-Proxy

export const IFLOW_OAUTH_AUTHORIZE_URL = "https://iflow.cn/oauth";
export const IFLOW_OAUTH_TOKEN_URL = "https://iflow.cn/oauth/token";
export const IFLOW_USER_INFO_URL = "https://iflow.cn/api/oauth/getUserInfo";
export const IFLOW_API_BASE_URL = "https://apis.iflow.cn/v1";

// Client credentials (from repo reference)
export const IFLOW_CLIENT_ID = process.env.IFLOW_CLIENT_ID || "10009311001";
export const IFLOW_CLIENT_SECRET =
  process.env.IFLOW_CLIENT_SECRET || "4Z3YjXycVsQvyGF1etiNlIBB4RsqSDtW";

// OAuth callback - Iflow requires this specific port
export const IFLOW_REDIRECT_URI = "http://localhost:11451/oauth2callback";

// Supported OpenAI-compatible parameters for Iflow API
export const IFLOW_SUPPORTED_PARAMS = new Set([
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
  // Reasoning parameters for thinking models
  "reasoning_effort",
  "reasoning",
]);

// Available Iflow models
export const IFLOW_MODELS = new Set([
  "glm-4.7",
  "glm-4.6",
  "iflow-rome-30ba3b",
  "minimax-m2.1",
  "minimax-m2",
  "qwen3-coder-plus",
  "kimi-k2",
  "kimi-k2.5",
  "kimi-k2-0905",
  "kimi-k2-thinking",
  "qwen3-max",
  "qwen3-235b-a22b-thinking-2507",
  "deepseek-v3.2-chat",
  "deepseek-v3.2",
  "deepseek-v3.1",
  "deepseek-v3",
  "deepseek-r1",
  "qwen3-vl-plus",
  "qwen3-235b-a22b-instruct",
  "qwen3-235b",
]);

// Token refresh buffer (24 hours before expiry)
export const IFLOW_REFRESH_BUFFER_SECONDS = 24 * 60 * 60;
