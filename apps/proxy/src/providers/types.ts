export interface UpstreamResponse {
  status: number;
  headers: Record<string, string>;
  body: ReadableStream<Uint8Array> | null;
}

export interface ProviderAccountLike {
  id: string;
  userId: string;
  provider: string;
  name: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  apiKey: string | null;
  projectId: string | null;
  tier: string | null;
  accountId: string | null;
  email: string | null;
  isActive: boolean;
  disabledUntil: Date | null;
  lastUsedAt: Date | null;
  status: string;
}

export interface RefreshedCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  projectId: string;
  tier: string;
  email: string;
  accountId: string;
  storeAccessToken: string;
}

export interface Provider {
  makeRequest(
    client: HttpClient,
    ctx: RequestContext,
    credentials: string,
    account: ProviderAccountLike,
    body: Record<string, unknown>,
    stream: boolean,
  ): Promise<UpstreamResponse>;
}

export interface AuthlessProvider extends Provider {
  authless(): boolean;
}

export interface CredentialRefresher extends Provider {
  refreshCredentials(ctx: RequestContext, client: HttpClient, refreshToken: string, account: ProviderAccountLike): Promise<RefreshedCredentials>;
}

export interface RefreshBufferProvider extends Provider {
  refreshBuffer(): number;
}

export interface RequestContext {
  signal?: AbortSignal;
}

export interface HttpClient {
  fetch(url: string, init: {
    method: string;
    headers: Record<string, string>;
    body?: string | Uint8Array | null;
    signal?: AbortSignal;
  }): Promise<UpstreamResponse>;
}
