import type { ProviderAccount } from "@opendum/database";

export interface RefreshedCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
  projectId?: string;
  tier?: string;
  email?: string;
  accountId?: string;
}

export interface ProviderRequestOptions {
  account: ProviderAccount;
  credentials?: string;
  body: Record<string, unknown>;
  stream: boolean;
  signal?: AbortSignal;
}

export interface Provider {
  name: string;
  isAuthless?(): boolean;
  getRefreshBuffer?(): number; // in seconds
  refreshCredentials?(
    refreshToken: string,
    account: ProviderAccount
  ): Promise<RefreshedCredentials>;
  makeRequest(options: ProviderRequestOptions): Promise<Response>;
}
