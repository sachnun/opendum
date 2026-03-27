// Cerebras API constants

export const CEREBRAS_API_BASE_URL = "https://api.cerebras.ai/v1";

// Cerebras is OpenAI-compatible but does NOT support:
// - frequency_penalty
// - presence_penalty
// - logit_bias
export const CEREBRAS_SUPPORTED_PARAMS = new Set([
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
  "stop",
  "seed",
  "response_format",
  "reasoning_effort",
  "n",
  "logprobs",
  "top_logprobs",
]);
