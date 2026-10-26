import { eq } from "drizzle-orm";

import { db, providerAccount, type ProviderAccount } from "@opendum/database";
import { decrypt, encrypt, hashString } from "#web/lib/encryption.js";
import { Effect } from "effect";
import { fetchExternalEffect } from "#web/lib/external.js";
import { fromPromise } from "#web/lib/task.js";
import { badRequest, unavailable } from "#web/errors.js";
import type { OAuthResult } from "../types.js";
import { httpError } from "../provider-http-errors.js";
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

function tokenExpired(expiresAt: Date): boolean {
  const bufferMs = REFRESH_BUFFER_SECONDS * 1000;
  return Date.now() > expiresAt.getTime() - bufferMs;
}

type CredentialAccount = Pick<ProviderAccount, "id" | "accessToken" | "refreshToken" | "expiresAt">;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function jwtClaims(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;

    const payloadPart = parts[1];
    if (!payloadPart) return null;
    const payload = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    return asRecord(JSON.parse(atob(padded)));
  } catch {
    return null;
  }
}

function tokenIdentity(accessToken: string): string | null {
  const claims = jwtClaims(accessToken);
  if (!claims) return null;

  const candidates = [
    claims.sub,
    claims.email,
    claims.username,
    claims["cognito:username"],
    claims.user_id,
    claims.account_id,
  ];

  for (const candidate of candidates) {
    const value = nonEmpty(candidate);
    if (value) return value;
  }

  return null;
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
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

const generateCodeChallenge = Effect.fn("kiro.generateCodeChallenge")(function* (verifier: string) {
  const encoded = new TextEncoder().encode(verifier);
  const digest = yield* fromPromise(
    () => crypto.subtle.digest("SHA-256", encoded),
    "Failed to build Kiro code challenge"
  );
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
});

const exchangeKiroCode = Effect.fn("kiro.exchangeCode")(function* (
  code: string,
  redirectUri: string,
  codeVerifier?: string
) {
  if (!codeVerifier) {
    return yield* badRequest("Code verifier is required for Kiro token exchange");
  }

  const response = yield* fetchExternalEffect(TOKEN_ENDPOINT, {
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

  if (!response.ok) {
    const errorText = yield* fromPromise(() => response.text(), "Failed to read Kiro response");
    return yield* unavailable(
      httpError("Kiro", response, errorText, {
        endpointLabel: "token exchange endpoint",
      })
    );
  }

  const data = yield* readJson<ExchangeResponse>(response);
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
  const response = yield* fetchExternalEffect(REFRESH_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "KiroIDE",
    },
    body: JSON.stringify({ refreshToken }),
  });

  if (!response.ok) {
    const errorText = yield* fromPromise(() => response.text(), "Failed to read Kiro response");
    return yield* unavailable(
      httpError("Kiro", response, errorText, {
        endpointLabel: "token refresh endpoint",
      })
    );
  }

  const data = yield* readJson<KiroRefreshResponse>(response);
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
  if (!tokenExpired(account.expiresAt)) return decrypt(account.accessToken);

  const refreshed = yield* refreshKiroToken(decrypt(account.refreshToken));
  yield* fromPromise(
    () =>
      db
        .update(providerAccount)
        .set({
          accessToken: encrypt(refreshed.accessToken),
          refreshToken: encrypt(refreshed.refreshToken!),
          expiresAt: refreshed.expiresAt,
          ...(refreshed.accountId ? { accountId: refreshed.accountId } : {}),
        })
        .where(eq(providerAccount.id, account.id)),
    "Failed to persist refreshed Kiro credentials"
  );

  return refreshed.accessToken;
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

function readJson<T>(response: Response) {
  return fromPromise(
    async () => ((await response.json()) as T),
    "Failed to read Kiro response"
  );
}
