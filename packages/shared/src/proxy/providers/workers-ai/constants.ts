// Cloudflare Workers AI API constants

export const WORKERS_AI_API_BASE_URL = "https://api.cloudflare.com/client/v4/accounts";

export function getWorkersAiChatUrl(accountId: string): string {
  return `${WORKERS_AI_API_BASE_URL}/${accountId}/ai/v1/chat/completions`;
}

export function getWorkersAiModelsUrl(accountId: string): string {
  return `${WORKERS_AI_API_BASE_URL}/${accountId}/ai/v1/models`;
}

export const WORKERS_AI_SUPPORTED_PARAMS = new Set([
  "model",
  "messages",
  "temperature",
  "top_p",
  "max_tokens",
  "stream",
  "stream_options",
  "tools",
  "tool_choice",
  "presence_penalty",
  "frequency_penalty",
  "stop",
  "seed",
  "response_format",
  "n",
]);
