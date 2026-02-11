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

export const OLLAMA_CLOUD_MODEL_MAP: Record<string, string> = {
  "cogito-2.1-671b": "cogito-2.1:671b",
  "deepseek-v3.1-671b": "deepseek-v3.1:671b",
  "deepseek-v3.2": "deepseek-v3.2",
  "devstral-2-123b": "devstral-2:123b",
  "devstral-small-2-24b": "devstral-small-2:24b",
  "gemini-3-flash-preview": "gemini-3-flash-preview",
  "gemma3-12b": "gemma3:12b",
  "gemma3-27b": "gemma3:27b",
  "gemma3-4b": "gemma3:4b",
  "glm-4.6": "glm-4.6",
  "glm-4.7": "glm-4.7",
  "glm-5": "glm-5",
  "gpt-oss-120b": "gpt-oss:120b",
  "gpt-oss-120b-medium": "gpt-oss:120b",
  "gpt-oss-20b": "gpt-oss:20b",
  "kimi-k2": "kimi-k2:1t",
  "kimi-k2-1t": "kimi-k2:1t",
  "kimi-k2-thinking": "kimi-k2-thinking",
  "kimi-k2.5": "kimi-k2.5",
  "minimax-m2": "minimax-m2",
  "minimax-m2.1": "minimax-m2.1",
  "ministral-3-14b": "ministral-3:14b",
  "ministral-3-3b": "ministral-3:3b",
  "ministral-3-8b": "ministral-3:8b",
  "mistral-large-3-675b": "mistral-large-3:675b",
  "nemotron-3-nano-30b": "nemotron-3-nano:30b",
  "qwen3-coder-480b": "qwen3-coder:480b",
  "qwen3-coder-next": "qwen3-coder-next",
  "qwen3-next-80b": "qwen3-next:80b",
  "qwen3-vl-235b": "qwen3-vl:235b",
  "qwen3-vl-235b-instruct": "qwen3-vl:235b-instruct",
  "rnj-1-8b": "rnj-1:8b",
};

export const OLLAMA_CLOUD_MODELS = new Set(Object.keys(OLLAMA_CLOUD_MODEL_MAP));
