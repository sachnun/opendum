export const OPENCODE_CHAT_COMPLETIONS_ENDPOINT = "https://unroxy.koyeb.app/opencode.ai/zen/v1/chat/completions";
export const OPENCODE_RESPONSES_ENDPOINT = "https://unroxy.koyeb.app/opencode.ai/zen/v1/responses";
export const OPENCODE_PUBLIC_API_KEY = "public";
export const OPENCODE_CLIENT = "cli";
export const OPENCODE_USER_AGENT = "opencode/1.15.8";

export const SUPPORTED_OPENCODE_PARAMS = new Set([
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
