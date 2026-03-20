// Nvidia API constants

export const NVIDIA_NIM_API_BASE_URL = "https://integrate.api.nvidia.com/v1";

export const NVIDIA_NIM_SUPPORTED_PARAMS = new Set([
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
