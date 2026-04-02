// Kilo Code (Kilo Gateway) API constants

export const KILO_CODE_API_BASE_URL = "https://api.kilo.ai/api/gateway";

export const KILO_CODE_SUPPORTED_PARAMS = new Set([
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
