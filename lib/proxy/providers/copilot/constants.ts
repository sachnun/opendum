// GitHub Copilot OAuth and API constants

// OAuth App client id (matches OpenCode)
export const COPILOT_CLIENT_ID = "Ov23li8tweQw6odWQebz";

// OAuth endpoints (GitHub device flow)
export const COPILOT_DEVICE_CODE_ENDPOINT =
  "https://github.com/login/device/code";
export const COPILOT_TOKEN_ENDPOINT =
  "https://github.com/login/oauth/access_token";

// API endpoint (OpenAI-compatible)
export const COPILOT_API_BASE_URL = "https://api.githubcopilot.com";

// Basic user identity endpoint
export const COPILOT_USER_ENDPOINT = "https://api.github.com/user";

// OAuth scope
export const COPILOT_SCOPE = "read:user user";

// Supported OpenAI-compatible parameters
export const COPILOT_SUPPORTED_PARAMS = new Set([
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
  "reasoning",
  "reasoning_effort",
]);

// Keep Copilot request headers aligned with OpenCode plugin behavior.
export const COPILOT_OPENCODE_USER_AGENT = "opencode/1.1.65";
export const COPILOT_OPENCODE_INTENT = "conversation-edits";

// Copilot models (synced from models.dev github-copilot)
export const COPILOT_MODELS = new Set([
  "claude-haiku-4-5",
  "claude-opus-4-1",
  "claude-opus-4-5",
  "claude-opus-4-6",
  "claude-sonnet-4",
  "claude-sonnet-4-5",
  "gemini-2.5-pro",
  "gemini-3-flash-preview",
  "gemini-3-pro-preview",
  "gpt-5",
  "gpt-5.1",
  "gpt-5.1-codex",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5-mini",
  "gpt-4.1",
  "gpt-4o",
  "grok-code-fast-1",
]);

// Canonical model key -> Copilot upstream model id
export const COPILOT_MODEL_MAP: Record<string, string> = {
  "claude-haiku-4-5": "claude-haiku-4.5",
  "claude-opus-4-1": "claude-opus-41",
  "claude-opus-4-5": "claude-opus-4.5",
  "claude-opus-4-6": "claude-opus-4.6",
  "claude-sonnet-4-5": "claude-sonnet-4.5",
};

// Polling defaults
export const COPILOT_POLLING_INTERVAL = 5;
export const COPILOT_DEVICE_CODE_EXPIRY = 900;

// Refresh buffer for expiring OAuth tokens
export const COPILOT_REFRESH_BUFFER_SECONDS = 5 * 60;

// Keep X-Initiator in agent mode for 5 hours per account
export const COPILOT_X_INITIATOR_WINDOW_MS = 5 * 60 * 60 * 1000;
