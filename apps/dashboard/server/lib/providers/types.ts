/**
 * Result of OAuth token exchange or refresh
 */
export interface OAuthResult {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
  email: string;
  apiKey?: string;
  projectId?: string;  // Antigravity only
  tier?: string;
  accountId?: string;  // Codex only: ChatGPT account ID from JWT
  workspaceId?: string; // Codex only: workspace/org identifier when available
}
