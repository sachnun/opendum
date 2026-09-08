export const CLINE_API_BASE = "https://api.cline.bot/api/v1";
export const CLINE_REFRESH_PATH = "/auth/refresh";
export const CLINE_CHAT_PATH = "/chat/completions";
export const CLINE_ACCESS_TTL_MS = 60 * 60 * 1000;
export const CLINE_REFRESH_BUFFER_SECONDS = 300;

export const CLINE_REQUEST_HEADERS: Record<string, string> = {
  "HTTP-Referer": "https://cline.bot",
  "X-Title": "Pi",
  "X-CLIENT-TYPE": "cline-sdk",
};

export const SUPPORTED_CLINE_PARAMS = new Set([
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
  "parallel_tool_calls",
  "presence_penalty",
  "frequency_penalty",
  "n",
  "stop",
  "seed",
  "response_format",
  "reasoning",
  "reasoning_effort",
]);
