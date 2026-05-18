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
  tier?: string;       // Provider-specific account tier or plan
  accountId?: string;  // Codex only: ChatGPT account ID from JWT
  workspaceId?: string; // Codex only: workspace/org identifier when available
}
