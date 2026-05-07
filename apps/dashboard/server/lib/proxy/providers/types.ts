// Provider abstraction types for multi-provider support

import type { ProviderAccount } from "../../db/schema.js";

/**
 * Provider configuration metadata
 */
export interface ProviderConfig {
  name: string;
  displayName: string;
  supportedModels: Set<string>;
}

/**
 * Result of OAuth token exchange or refresh
 */
export interface OAuthResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  email: string;
  // Provider-specific fields
  apiKey?: string;
  projectId?: string;  // Antigravity only
  tier?: string;       // Antigravity only: "free" | "paid"
  accountId?: string;  // Codex only: ChatGPT account ID from JWT
  workspaceId?: string; // Codex only: workspace/org identifier when available
}

/**
 * Reasoning effort levels for OpenAI-style reasoning parameter
 */
export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";

/**
 * OpenAI-style reasoning parameter (Responses API format)
 */
export interface ReasoningConfig {
  effort?: ReasoningEffort;
  summary?: "auto" | "concise" | "detailed";
}

/**
 * Chat completion request body (OpenAI format)
 */
export interface ChatCompletionRequest {
  model: string;
  instructions?: string;
  include?: string[];
  previous_response_id?: string;
  service_tier?: string;
  messages: Array<{
    role: string;
    content: string | Array<{ type: string; [key: string]: unknown }>;
    name?: string;
    tool_calls?: unknown[];
    tool_call_id?: string;
  }>;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
  tools?: Array<{
    type: string;
    function: {
      name: string;
      description?: string;
      parameters?: Record<string, unknown>;
      strict?: boolean;
    };
  }>;
  tool_choice?: string | { type: string; function?: { name: string } };
  presence_penalty?: number;
  frequency_penalty?: number;
  n?: number;
  stop?: string | string[];
  seed?: number;
  response_format?: { type: string };
  
  // OpenAI-style reasoning parameter (Responses API format)
  reasoning?: ReasoningConfig;
  
  // Legacy/extended parameters for thinking models (backward compatibility)
  reasoning_effort?: ReasoningEffort;
  thinking_budget?: number;
  include_thoughts?: boolean;
  
  // Internal flag - controls whether reasoning_content is included in response
  // Set automatically based on whether user requested reasoning
  _includeReasoning?: boolean;

  // OpenAI Responses API parallel tool call control
  parallel_tool_calls?: boolean;

  // Internal passthrough for Responses API input items
  // Used by providers that natively support the Responses API.
  _responsesInput?: Array<Record<string, unknown>>;

  // Internal header hint for Copilot requests
  _copilotXInitiator?: "user" | "agent";

  // Internal header hint for Codex requests
  _sessionId?: string;
}

export type ProxyEndpointType =
  | "chat_completions"
  | "messages"
  | "responses";

/**
 * Provider interface - all providers must implement this
 */
export interface Provider {
  readonly config: ProviderConfig;

  /**
   * Optional request preparation hook.
   * Allows provider-specific normalization/injection before upstream request.
   */
  prepareRequest?(
    account: ProviderAccount,
    body: ChatCompletionRequest,
    endpoint: ProxyEndpointType
  ): ChatCompletionRequest | Promise<ChatCompletionRequest>;

  /**
   * Generate OAuth authorization URL
   * @param state CSRF protection state
   * @param codeVerifier PKCE code verifier (for Antigravity)
   */
  getAuthUrl(state: string, codeVerifier?: string): string | Promise<string>;

  /**
   * Exchange authorization code for tokens
   * @param code Authorization code from OAuth callback
   * @param redirectUri Redirect URI used in auth request
   * @param codeVerifier PKCE code verifier (for Antigravity)
   */
  exchangeCode(
    code: string,
    redirectUri: string,
    codeVerifier?: string
  ): Promise<OAuthResult>;

  /**
   * Refresh access token using refresh token
   * @param refreshToken Current refresh token
   */
  refreshToken(refreshToken: string): Promise<OAuthResult>;

  /**
   * Get valid credentials for making API requests
   * Handles token refresh if needed
   * @param account Provider account from database
   * @returns API key or access token
   */
  getValidCredentials(account: ProviderAccount): Promise<string>;

  /**
   * Make a request to the provider's API
   * @param credentials API key or access token
   * @param account Provider account (for additional metadata like projectId)
   * @param body Request body in OpenAI format
   * @param stream Whether to stream the response
   */
  makeRequest(
    credentials: string,
    account: ProviderAccount,
    body: ChatCompletionRequest,
    stream: boolean
  ): Promise<Response>;
}

/**
 * Provider names enum
 */
export const ProviderName = {
  ANTIGRAVITY: "antigravity",
  COPILOT: "copilot",
  QWEN_CODE: "qwen_code",
  GEMINI_CLI: "gemini_cli",
  CODEX: "codex",
  KIRO: "kiro",
  OLLAMA_CLOUD: "ollama_cloud",
  OPENROUTER: "openrouter",
  NVIDIA_NIM: "nvidia_nim",
  GROQ: "groq",
  CEREBRAS: "cerebras",
  KILO_CODE: "kilo_code",
  WORKERS_AI: "workers_ai",
} as const;

export type ProviderNameType = (typeof ProviderName)[keyof typeof ProviderName];

export const OAUTH_PROVIDER_NAMES: ProviderNameType[] = [
  ProviderName.ANTIGRAVITY,
  ProviderName.COPILOT,
  ProviderName.QWEN_CODE,
  ProviderName.GEMINI_CLI,
  ProviderName.CODEX,
  ProviderName.KIRO,
];
