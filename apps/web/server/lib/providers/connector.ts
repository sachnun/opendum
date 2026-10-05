import type { OAuthResult } from "./types.ts";

export type AuthUrlResult = {
  authUrl: string;
  state: string | null;
  codeVerifier: string | null;
};

export type DeviceInitiation = {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  verificationUrlComplete?: string;
  expiresIn: number;
  interval: number;
};

export type DevicePollInput = {
  deviceCode: string;
  userCode?: string;
  codeVerifier?: string;
  method?: string;
  machineId?: string;
};

export type DevicePollResult =
  | OAuthResult
  | { pending: boolean; retryAfterSeconds?: number }
  | { error: string };

export type AccountOptionOverrides = {
  email?: string;
  accountId?: string | null;
  dedupeByAccountId?: boolean;
};

export interface AccountConnector {
  readonly name: string;
  readonly label: string;
  readonly requiresCodeVerifier?: boolean;
  buildAuthUrl?(): Promise<AuthUrlResult>;
  exchangeCode?(code: string, codeVerifier?: string | null): Promise<OAuthResult>;
  accountOptions?(oauthResult: OAuthResult): AccountOptionOverrides | undefined;
  readonly device?: {
    readonly emailPrefix: string;
    initiate(): Promise<DeviceInitiation>;
    poll(input: DevicePollInput): Promise<DevicePollResult>;
  };
  connectSession?(sessionJson: string): OAuthResult;
}

export const GOOGLE_OAUTH_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";

export function generateOAuthState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString("base64url");
}
