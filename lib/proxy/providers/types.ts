// Provider abstraction types for multi-provider support

import type { ProviderAccount } from "@prisma/client";

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
  apiKey?: string;     // Iflow only
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

  // Internal passthrough for Responses API input items
  // Used by providers that natively support the Responses API.
  _responsesInput?: Array<Record<string, unknown>>;

  // Internal header hint for Copilot requests
  _copilotXInitiator?: "user" | "agent";
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
  getAuthUrl(state: string, codeVerifier?: string): string;

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
   * @returns API key (Iflow) or access token (Antigravity)
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
  IFLOW: "iflow",
  ANTIGRAVITY: "antigravity",
  COPILOT: "copilot",
  QWEN_CODE: "qwen_code",
  GEMINI_CLI: "gemini_cli",
  CODEX: "codex",
  KIRO: "kiro",
  NVIDIA_NIM: "nvidia_nim",
  OLLAMA_CLOUD: "ollama_cloud",
  OPENROUTER: "openrouter",
} as const;

export type ProviderNameType = (typeof ProviderName)[keyof typeof ProviderName];

export const PROVIDER_ALIASES: Record<string, ProviderNameType> = {
  copilot: ProviderName.COPILOT,
  "github-copilot": ProviderName.COPILOT,
  github_copilot: ProviderName.COPILOT,
  "github-copilot-enterprise": ProviderName.COPILOT,
  github_copilot_enterprise: ProviderName.COPILOT,
};

export function normalizeProviderAlias(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  return PROVIDER_ALIASES[normalized] ?? normalized;
}

export const OAUTH_PROVIDER_NAMES: ProviderNameType[] = [
  ProviderName.IFLOW,
  ProviderName.ANTIGRAVITY,
  ProviderName.COPILOT,
  ProviderName.QWEN_CODE,
  ProviderName.GEMINI_CLI,
  ProviderName.CODEX,
  ProviderName.KIRO,
];

export const API_KEY_PROVIDER_NAMES: ProviderNameType[] = [
  ProviderName.NVIDIA_NIM,
  ProviderName.OLLAMA_CLOUD,
  ProviderName.OPENROUTER,
];
