import { eq } from "drizzle-orm";

import { db } from "../../db/index.js";
import { providerAccount, type ProviderAccount } from "../../db/schema.js";
import { decrypt, encrypt } from "../../encryption.js";
import { fetchInternalProvider } from "../../proxy/internal-relay.js";
import type { OAuthResult } from "../types.js";
import { formatProviderHttpError } from "../provider-http-errors.js";
import {
  BROWSER_REDIRECT_URI,
  CLIENT_ID,
  REFRESH_BUFFER_SECONDS,
  TOKEN_ENDPOINT,
} from "./constants.js";

interface CodexTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  id_token?: string;
}

export function generateCodeVerifier(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const base64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  return value as Record<string, unknown>;
}

function extractOrganizationId(claims: Record<string, unknown> | null): string | null {
  if (!claims) {
    return null;
  }

  const organizations = claims.organizations;
  if (!Array.isArray(organizations)) {
    return null;
  }

  const normalizedOrganizations = organizations
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => item !== null);

  const defaultOrganization = normalizedOrganizations.find(
    (organization) => organization.is_default === true || organization.default === true
  );

  if (defaultOrganization) {
    const defaultOrganizationId = toNonEmptyString(defaultOrganization.id);
    if (defaultOrganizationId) {
      return defaultOrganizationId;
    }
  }

  for (const organization of normalizedOrganizations) {
    const organizationId = toNonEmptyString(organization.id);
    if (organizationId) {
      return organizationId;
    }
  }

  return null;
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

function extractWorkspaceIdFromClaims(decoded: Record<string, unknown>): string | null {
  const authClaims = asRecord(decoded["https://api.openai.com/auth"]);

  const workspaceCandidates = [
    toNonEmptyString(authClaims?.chatgpt_workspace_id),
    toNonEmptyString(authClaims?.workspace_id),
    toNonEmptyString(authClaims?.organization_id),
    extractOrganizationId(authClaims),
    toNonEmptyString(decoded.chatgpt_workspace_id),
    toNonEmptyString(decoded.workspace_id),
    toNonEmptyString(decoded.organization_id),
    extractOrganizationId(decoded),
  ];

  for (const candidate of workspaceCandidates) {
    if (candidate) {
      return candidate;
    }
  }

  return null;
}

function extractAccountIdFromClaims(decoded: Record<string, unknown>): string | null {
  const authClaims = asRecord(decoded["https://api.openai.com/auth"]);
  const accountCandidates = [
    toNonEmptyString(authClaims?.chatgpt_account_id),
    toNonEmptyString(decoded.chatgpt_account_id),
  ];

  for (const candidate of accountCandidates) {
    if (candidate) {
      return candidate;
    }
  }

  return null;
}

function extractAccountIdFromJwt(token: string): string | null {
  const decoded = parseJwtClaims(token);
  return decoded ? extractAccountIdFromClaims(decoded) : null;
}

function extractWorkspaceIdFromJwt(token: string): string | null {
  const decoded = parseJwtClaims(token);
  return decoded ? extractWorkspaceIdFromClaims(decoded) : null;
}

function isTokenExpired(expiresAt: Date): boolean {
  const bufferMs = REFRESH_BUFFER_SECONDS * 1000;
  return Date.now() > expiresAt.getTime() - bufferMs;
}

function buildOAuthResult(tokens: CodexTokenResponse, refreshToken?: string): OAuthResult {
  const accountId =
    (tokens.id_token ? extractAccountIdFromJwt(tokens.id_token) : null) ||
    extractAccountIdFromJwt(tokens.access_token);
  const workspaceId =
    (tokens.id_token ? extractWorkspaceIdFromJwt(tokens.id_token) : null) ||
    extractWorkspaceIdFromJwt(tokens.access_token) ||
    accountId;

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || refreshToken || "",
    expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
    email: "",
    accountId: accountId || undefined,
    workspaceId: workspaceId || undefined,
  };
}

export const codexProvider = {
  async exchangeCode(
    code: string,
    redirectUri: string,
    codeVerifier?: string
  ): Promise<OAuthResult> {
    const body: Record<string, string> = {
      grant_type: "authorization_code",
      code,
      client_id: CLIENT_ID,
      redirect_uri: redirectUri || BROWSER_REDIRECT_URI,
    };

    if (codeVerifier) {
      body.code_verifier = codeVerifier;
    }

    const response = await fetchInternalProvider(TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(
        formatProviderHttpError("Codex", response, error, {
          endpointLabel: "token exchange endpoint",
        })
      );
    }

    return buildOAuthResult((await response.json()) as CodexTokenResponse);
  },

  async refreshToken(refreshToken: string): Promise<OAuthResult> {
    const response = await fetchInternalProvider(TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(
        formatProviderHttpError("Codex", response, error, {
          endpointLabel: "token refresh endpoint",
        })
      );
    }

    return buildOAuthResult((await response.json()) as CodexTokenResponse, refreshToken);
  },

  async getValidCredentials(account: ProviderAccount): Promise<string> {
    let accessToken = decrypt(account.accessToken);
    const refreshTokenValue = decrypt(account.refreshToken);

    const resolvedAccountId = extractAccountIdFromJwt(accessToken);
    if (resolvedAccountId && resolvedAccountId !== account.accountId) {
      try {
        await db
          .update(providerAccount)
          .set({ accountId: resolvedAccountId })
          .where(eq(providerAccount.id, account.id));
        account.accountId = resolvedAccountId;
      } catch {
        // Ignore account ID sync failures.
      }
    }

    if (isTokenExpired(account.expiresAt)) {
      try {
        const newTokens = await codexProvider.refreshToken(refreshTokenValue);
        const updateData: Record<string, unknown> = {
          accessToken: encrypt(newTokens.accessToken),
          refreshToken: encrypt(newTokens.refreshToken),
          expiresAt: newTokens.expiresAt,
        };

        if (newTokens.accountId) {
          updateData.accountId = newTokens.accountId;
          account.accountId = newTokens.accountId;
        }
        if (newTokens.workspaceId) {
          updateData.workspaceId = newTokens.workspaceId;
        }

        await db
          .update(providerAccount)
          .set(updateData)
          .where(eq(providerAccount.id, account.id));

        accessToken = newTokens.accessToken;
      } catch (error) {
        console.error(`Failed to refresh token for Codex account ${account.id}:`, error);
        if (new Date() >= account.expiresAt) {
          throw error;
        }
      }
    }

    return accessToken;
  },
};
