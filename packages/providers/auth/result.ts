export interface OAuthResult {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
  email: string;
  apiKey?: string;
  projectId?: string;
  tier?: string;
  accountId?: string;
  workspaceId?: string;
}
