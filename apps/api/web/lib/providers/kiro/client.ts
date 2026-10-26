import { hashString } from "#web/lib/encryption.js";
import { Effect } from "effect";
import { fetchExternalEffect } from "#web/lib/external.js";
import { badRequest, unavailable } from "#web/errors.js";
import type { OAuthResult } from "../types.js";
import { Pkce } from "../pkce.js";
import { ProviderResponse } from "../provider-response.js";
import { Jwt } from "@opendum/providers";
import { validToken, type CredentialAccount } from "../credentials.js";
import {
  AUTHORIZE_ENDPOINT,
  BROWSER_REDIRECT_URI,
  IDP,
  REFRESH_BUFFER_SECONDS,
  REFRESH_ENDPOINT,
  TOKEN_ENDPOINT,
} from "./constants.js";

interface ExchangeResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn?: number;
  profileArn?: string;
}

interface KiroRefreshResponse {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  profileArn?: string;
}

const response = new ProviderResponse("Kiro");

function tokenIdentity(accessToken: string): string | null {
  const claims = Jwt.claims(accessToken);
  if (!claims) return null;
  return Jwt.first(claims, [
    "sub",
    "email",
    "username",
    "cognito:username",
    "user_id",
    "account_id",
  ]) || null;
}

function accountIdentity(accessToken: string, refreshToken: string, profileArn: string) {
  const identity = tokenIdentity(accessToken);
  const credentialFingerprint = hashString(refreshToken || accessToken).slice(0, 16);
  const displayIdentifier = [profileArn, identity, credentialFingerprint]
    .filter((value): value is string => Boolean(value))
    .join(":") || credentialFingerprint;

  return {
    email: `kiro-${displayIdentifier}`,
    accountId: profileArn || undefined,
  };
}

export function codeVerifier(): string {
  return Pkce.verifier();
}

const generateCodeChallenge = (verifier: string) => Pkce.challenge(verifier, "Kiro");

const exchangeKiroCode = Effect.fn("kiro.exchangeCode")(function* (
  code: string,
  redirectUri: string,
  codeVerifier?: string
) {
  if (!codeVerifier) {
    return yield* badRequest("Code verifier is required for Kiro token exchange");
  }

  const result = yield* fetchExternalEffect(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "KiroIDE",
    },
    body: JSON.stringify({
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri || BROWSER_REDIRECT_URI,
    }),
  });

  if (!result.ok) {
    const errorText = yield* response.text(result);
    return yield* unavailable(response.failure(result, errorText, "token exchange endpoint"));
  }

  const data = yield* response.json<ExchangeResponse>(result);
  const profileArn = data.profileArn || "";
  const identity = accountIdentity(data.accessToken, data.refreshToken, profileArn);

  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    expiresAt: new Date(Date.now() + (data.expiresIn || 3600) * 1000),
    email: identity.email,
    accountId: identity.accountId,
  } satisfies OAuthResult;
});

const refreshKiroToken = Effect.fn("kiro.refreshToken")(function* (refreshToken: string) {
  const result = yield* fetchExternalEffect(REFRESH_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "KiroIDE",
    },
    body: JSON.stringify({ refreshToken }),
  });

  if (!result.ok) {
    const errorText = yield* response.text(result);
    return yield* unavailable(response.failure(result, errorText, "token refresh endpoint"));
  }

  const data = yield* response.json<KiroRefreshResponse>(result);
  const profileArn = data.profileArn || "";
  const nextRefreshToken = data.refreshToken || refreshToken;
  const identity = accountIdentity(data.accessToken, nextRefreshToken, profileArn);

  return {
    accessToken: data.accessToken,
    refreshToken: nextRefreshToken,
    expiresAt: new Date(Date.now() + (data.expiresIn || 3600) * 1000),
    email: identity.email,
    accountId: identity.accountId,
  } satisfies OAuthResult;
});

const validCredentials = Effect.fn("kiro.getValidCredentials")(function* (
  account: CredentialAccount
) {
  return yield* validToken(account, {
    bufferSeconds: REFRESH_BUFFER_SECONDS,
    message: "Failed to persist refreshed Kiro credentials",
    refresh: refreshKiroToken,
    patch: (refreshed) => (refreshed.accountId ? { accountId: refreshed.accountId } : {}),
  });
});

export const kiroProvider = {
  exchangeCode: exchangeKiroCode,
  refreshToken: refreshKiroToken,
  getValidCredentials: validCredentials,
};

export const authUrl = Effect.fn("kiro.buildAuthUrl")(function* (
  state: string,
  codeVerifier: string
) {
  const codeChallenge = yield* generateCodeChallenge(codeVerifier);
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


