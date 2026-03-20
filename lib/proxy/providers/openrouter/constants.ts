// OpenRouter API constants

export const OPENROUTER_API_BASE_URL = "https://openrouter.ai/api/v1";

export const OPENROUTER_SUPPORTED_PARAMS = new Set([
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
