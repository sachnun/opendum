export const QODER_BASE_URL = "https://unroxy.koyeb.app/api.qoder.com/api";
export const QODER_REFRESH_PATH = "/v1/auth/refresh";
export const QODER_CHAT_PATH = "/v1/chat/completions";
export const QODER_ACCESS_TTL_MS = 24 * 60 * 60 * 1000;
export const QODER_REFRESH_BUFFER_SECONDS = 3600;

export const SUPPORTED_QODER_PARAMS = new Set([
  "model",
  "messages",
  "temperature",
  "top_p",
  "max_tokens",
  "max_completion_tokens",
  "stream",
  "stream_options",
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
