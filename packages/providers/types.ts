import type { Effect } from "effect";
import type { ProviderCredentialFailure, ProviderFailure } from "@opendum/providers/core/errors";

export type { ProviderFailure, ProviderCredentialFailure } from "@opendum/providers/core/errors";

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
  onResponseStart?: () => void;
  sessionId?: string;
  requestId?: string;
  projectId?: string;
};

export interface Provider {
  readonly name: string;
  makeRequest(request: ProviderRequest): Effect.Effect<Response, ProviderFailure>;
}

export interface AuthlessProvider {
  authless(): boolean;
}

export interface CredentialRefresher {
  refreshCredentials(
    refreshToken: string,
    account: ProviderAccount
  ): Effect.Effect<RefreshedCredentials, ProviderCredentialFailure>;
}

export interface RefreshBufferProvider {
  refreshBuffer(): number;
}

export const REFRESH_BUFFER_MS = 3 * 60 * 60 * 1000;
