export type ProviderAccount = {
  id: string;
  userId: string;
  provider: string;
  name?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: Date;
  apiKey?: string | null;
  projectId?: string | null;
  tier?: string | null;
  accountId?: string | null;
  email?: string | null;
  isActive?: boolean;
  status?: string;
  disabledUntil?: Date | null;
  lastUsedAt?: Date | null;
  createdAt?: Date;
};

export type RefreshedCredentials = {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  projectId?: string;
  tier?: string;
  paidTier?: string;
  email?: string;
  accountId?: string;
  storeAccessToken?: string;
};

export type ProviderRequest = {
  account: ProviderAccount;
  credentials: string;
  body: Record<string, unknown>;
  stream: boolean;
  onUpstreamResponseStart?: () => void;
  sessionId?: string;
  requestId?: string;
  projectId?: string;
};

export interface Provider {
  readonly name: string;
  makeRequest(request: ProviderRequest): Promise<Response>;
}

export interface AuthlessProvider {
  authless(): boolean;
}

export interface CredentialRefresher {
  refreshCredentials(refreshToken: string, account: ProviderAccount): Promise<RefreshedCredentials>;
}

export interface RefreshBufferProvider {
  refreshBuffer(): number;
}

export const OAUTH_REFRESH_BUFFER_MS = 3 * 60 * 60 * 1000;
