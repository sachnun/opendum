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
  apiKey?: string;     // iFlow only
  projectId?: string;  // Antigravity only
  tier?: string;       // Antigravity only: "free" | "paid"
}

/**
 * Chat completion request body (OpenAI format)
 */
export interface ChatCompletionRequest {
  model: string;
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
  // Extended parameters for thinking models
  reasoning_effort?: "none" | "low" | "medium" | "high";
  thinking_budget?: number;
  include_thoughts?: boolean;
}

/**
 * Provider interface - all providers must implement this
 */
export interface Provider {
  readonly config: ProviderConfig;

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
   * @returns API key (iFlow) or access token (Antigravity)
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
} as const;

export type ProviderNameType = (typeof ProviderName)[keyof typeof ProviderName];
