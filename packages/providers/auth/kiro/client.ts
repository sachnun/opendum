import { Effect } from "effect";

import { OAuthClient, tokenLifetime } from "@opendum/providers/auth/client";
import { validToken, type CredentialAccount } from "@opendum/providers/auth/credentials";
import { Pkce } from "@opendum/providers/auth/pkce";
import type { OAuthResult } from "@opendum/providers/auth/result";
import type { AuthRuntime } from "@opendum/providers/auth/runtime";
import { Jwt } from "@opendum/providers";
import {
  AUTHORIZE_ENDPOINT,
  BROWSER_REDIRECT_URI,
  IDP,
  REFRESH_BUFFER_SECONDS,
  REFRESH_ENDPOINT,
  TOKEN_ENDPOINT,
} from "@opendum/providers/auth/kiro/constants";

interface KiroToken {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  profileArn?: string;
}

const REQUEST_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json",
  "User-Agent": "KiroIDE",
};

function pickToken(payload: unknown): KiroToken | null {
  const value = payload as Partial<KiroToken> | null;
  if (!value || typeof value.accessToken !== "string" || !value.accessToken.trim()) return null;
  return value as KiroToken;
}

class KiroClient extends OAuthClient {
  constructor(runtime: AuthRuntime) {
    super({ provider: "kiro", label: "Kiro" }, runtime);
  }

  private identity(accessToken: string, refreshToken: string, profileArn: string) {
    const claims = Jwt.claims(accessToken);
    const identity = claims
      ? Jwt.first(claims, ["sub", "email", "username", "cognito:username", "user_id", "account_id"])
      : null;
    const fingerprint = this.runtime.hash(refreshToken || accessToken).slice(0, 16);
    const display = [profileArn, identity, fingerprint].filter((v): v is string => Boolean(v)).join(":");
    return { email: `kiro-${display || fingerprint}`, accountId: profileArn || undefined };
  }

  private toResult(data: KiroToken, refreshToken: string): OAuthResult & { refreshToken: string } {
    const nextRefresh = data.refreshToken || refreshToken;
    const identity = this.identity(data.accessToken, nextRefresh, data.profileArn ?? "");
    return {
      accessToken: data.accessToken,
      refreshToken: nextRefresh,
      expiresAt: tokenLifetime(data.expiresIn),
      email: identity.email,
      accountId: identity.accountId,
    };
  }

  readonly exchangeCode = (code: string, redirectUri: string, codeVerifier?: string) =>
    Effect.gen({ self: this }, function* (this: KiroClient) {
    if (!codeVerifier) return yield* Effect.fail(this.reject("Code verifier is required for Kiro token exchange"));
    const data = yield* this.decode<KiroToken>(
      {
        url: TOKEN_ENDPOINT,
        endpoint: "token exchange endpoint",
        init: {
          method: "POST",
          headers: REQUEST_HEADERS,
          body: JSON.stringify({
            code,
            code_verifier: codeVerifier,
            redirect_uri: redirectUri || BROWSER_REDIRECT_URI,
          }),
        },
      },
      pickToken
    );
    return this.toResult(data, data.refreshToken ?? "");
    });

  readonly refreshToken = (refreshToken: string) =>
    Effect.gen({ self: this }, function* (this: KiroClient) {
    const data = yield* this.decode<KiroToken>(
      {
        url: REFRESH_ENDPOINT,
        endpoint: "token refresh endpoint",
        init: { method: "POST", headers: REQUEST_HEADERS, body: JSON.stringify({ refreshToken }) },
      },
      pickToken
    );
    return this.toResult(data, refreshToken);
    });

  readonly getValidCredentials = (account: CredentialAccount) =>
    Effect.gen({ self: this }, function* (this: KiroClient) {
    return yield* validToken(
      account,
      {
        bufferSeconds: REFRESH_BUFFER_SECONDS,
        message: "Failed to persist refreshed Kiro credentials",
        refresh: (token) => this.refreshToken(token),
        patch: (refreshed) => (refreshed.accountId ? { accountId: refreshed.accountId } : {}),
      },
      this.runtime.store
    );
    });
}

export function kiroAuth(runtime: AuthRuntime) {
  const client = new KiroClient(runtime);

  const codeVerifier = (): string => Pkce.verifier();

  const authUrl = Effect.fn("kiro.buildAuthUrl")(function* (state: string, verifier: string) {
    const codeChallenge = yield* Pkce.challenge(verifier, "Kiro");
    const params = new URLSearchParams({
      idp: IDP,
      redirect_uri: BROWSER_REDIRECT_URI,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
      prompt: "select_account",
    });
    return `${AUTHORIZE_ENDPOINT}?${params.toString()}`;
  });

  return {
    kiroProvider: {
      exchangeCode: client.exchangeCode,
      refreshToken: client.refreshToken,
      getValidCredentials: client.getValidCredentials,
    },
    authUrl,
    codeVerifier,
    AUTHORIZE_ENDPOINT,
    authParams: (state: string) => ({
      idp: IDP,
      redirect_uri: BROWSER_REDIRECT_URI,
      state,
      prompt: "select_account",
    }),
  };
}
