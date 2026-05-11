import { eq } from "drizzle-orm";

import { db } from "../../db/index.js";
import { providerAccount, type ProviderAccount } from "../../db/schema.js";
import { decrypt, encrypt } from "../../encryption.js";
import { fetchInternalProvider } from "../../proxy/internal-relay.js";
import type { OAuthResult } from "../types.js";
import { formatProviderHttpError } from "../provider-http-errors.js";
import {
  AUTHORIZE_ENDPOINT,
  BROWSER_REDIRECT_URI,
  IDP,
  REFRESH_BUFFER_SECONDS,
  REFRESH_ENDPOINT,
  TOKEN_ENDPOINT,
} from "./constants.js";

interface KiroTokenExchangeResponse {
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

function isTokenExpired(expiresAt: Date): boolean {
  const bufferMs = REFRESH_BUFFER_SECONDS * 1000;
  return Date.now() > expiresAt.getTime() - bufferMs;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function parseJwtClaims(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;

    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    return asRecord(JSON.parse(atob(padded)));
  } catch {
    return null;
  }
}

function extractTokenIdentity(accessToken: string): string | null {
  const claims = parseJwtClaims(accessToken);
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
    const value = toNonEmptyString(candidate);
    if (value) return value;
  }

  return null;
}

function buildKiroAccountIdentity(accessToken: string, profileArn: string) {
  const tokenIdentity = extractTokenIdentity(accessToken);
  const displayIdentifier = tokenIdentity
    ? profileArn && tokenIdentity !== profileArn
      ? `${profileArn}:${tokenIdentity}`
      : tokenIdentity
    : profileArn || crypto.randomUUID();

  return {
    email: `kiro-${displayIdentifier}`,
    accountId: profileArn || undefined,
  };
}

export function generateCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoded = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export const kiroProvider = {
  async exchangeCode(
    code: string,
    redirectUri: string,
    codeVerifier?: string
  ): Promise<OAuthResult> {
    if (!codeVerifier) {
      throw new Error("Code verifier is required for Kiro token exchange");
    }

    const response = await fetchInternalProvider(TOKEN_ENDPOINT, {
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
      const errorText = await response.text();
      throw new Error(
        formatProviderHttpError("Kiro", response, errorText, {
          endpointLabel: "token exchange endpoint",
        })
      );
    }

    const data = (await response.json()) as KiroTokenExchangeResponse;
    const profileArn = data.profileArn || "";
    const identity = buildKiroAccountIdentity(data.accessToken, profileArn);

    return {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      expiresAt: new Date(Date.now() + (data.expiresIn || 3600) * 1000),
      email: identity.email,
      accountId: identity.accountId,
    };
  },

  async refreshToken(refreshToken: string): Promise<OAuthResult> {
    const response = await fetchInternalProvider(REFRESH_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "KiroIDE",
      },
      body: JSON.stringify({ refreshToken }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        formatProviderHttpError("Kiro", response, errorText, {
          endpointLabel: "token refresh endpoint",
        })
      );
    }

    const data = (await response.json()) as KiroRefreshResponse;
    const profileArn = data.profileArn || "";
    const identity = buildKiroAccountIdentity(data.accessToken, profileArn);

    return {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken || refreshToken,
      expiresAt: new Date(Date.now() + (data.expiresIn || 3600) * 1000),
      email: identity.email,
      accountId: identity.accountId,
    };
  },

  async getValidCredentials(account: ProviderAccount): Promise<string> {
    let accessToken = decrypt(account.accessToken);
    const refreshTokenValue = decrypt(account.refreshToken);

    if (!isTokenExpired(account.expiresAt)) {
      return accessToken;
    }

    const refreshed = await kiroProvider.refreshToken(refreshTokenValue);
    await db
      .update(providerAccount)
      .set({
        accessToken: encrypt(refreshed.accessToken),
        refreshToken: encrypt(refreshed.refreshToken),
        expiresAt: refreshed.expiresAt,
        ...(refreshed.accountId ? { accountId: refreshed.accountId } : {}),
        ...(refreshed.email ? { email: refreshed.email } : {}),
      })
      .where(eq(providerAccount.id, account.id));

    accessToken = refreshed.accessToken;
    return accessToken;
  },
};

export async function buildKiroAuthUrl(state: string, codeVerifier: string): Promise<string> {
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const params = new URLSearchParams({
    idp: IDP,
    redirect_uri: BROWSER_REDIRECT_URI,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
    prompt: "select_account",
  });

  return `${AUTHORIZE_ENDPOINT}?${params.toString()}`;
}
