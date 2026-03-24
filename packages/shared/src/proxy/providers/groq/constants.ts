// Groq API constants

export const GROQ_API_BASE_URL = "https://api.groq.com/openai/v1";

export const GROQ_SUPPORTED_PARAMS = new Set([
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
  "stop",
  "seed",
  "response_format",
  "reasoning_effort",
  "n",
]);
