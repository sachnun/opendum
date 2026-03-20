// Ollama Cloud API constants

export const OLLAMA_CLOUD_API_BASE_URL = "https://ollama.com/v1";

export const OLLAMA_CLOUD_SUPPORTED_PARAMS = new Set([
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
