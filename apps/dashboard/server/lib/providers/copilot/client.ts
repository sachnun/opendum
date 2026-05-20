import { eq } from "drizzle-orm";

import { db } from "../../db/index.js";
import { providerAccount, type ProviderAccount } from "../../db/schema.js";
import { decrypt, encrypt } from "../../encryption.js";
import { fetchInternalProvider } from "../../proxy/internal-relay.js";
import type { OAuthResult } from "../types.js";
import { formatProviderHttpError } from "../provider-http-errors.js";
import {
  CLIENT_ID,
  DEVICE_CODE_ENDPOINT,
  DEVICE_CODE_EXPIRY,
  POLLING_INTERVAL,
  REFRESH_BUFFER_SECONDS,
  SCOPE,
  TOKEN_ENDPOINT,
  USER_AGENT,
  USER_ENDPOINT,
} from "./constants.js";

const GITHUB_API_BASE_URL = "https://api.github.com";
const COPILOT_INTERNAL_HEADERS = {
  Accept: "application/json",
  "User-Agent": "GitHubCopilotChat/0.26.7",
  "Editor-Version": "vscode/1.96.2",
  "Editor-Plugin-Version": "copilot-chat/0.26.7",
  "X-GitHub-Api-Version": "2025-04-01",
};

interface CopilotDeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

interface CopilotTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  interval?: number;
  error?: string;
  error_description?: string;
}

interface CopilotInternalUserResponse {
  access_type_sku?: unknown;
  copilot_plan?: unknown;
  quota_snapshots?: unknown;
}

const POLLING_SAFETY_MARGIN_SECONDS = 3;

function isTokenExpired(expiresAt: Date): boolean {
  const bufferMs = REFRESH_BUFFER_SECONDS * 1000;
  return Date.now() > expiresAt.getTime() - bufferMs;
}

type CredentialAccount = Pick<ProviderAccount, "id" | "accessToken" | "refreshToken" | "expiresAt">;

async function fetchCopilotIdentity(accessToken: string): Promise<string> {
  try {
    const response = await fetchInternalProvider(USER_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "User-Agent": USER_AGENT,
      },
      cache: "no-store",
    });

    if (!response.ok) {
      return "";
    }

    const user = (await response.json()) as { login?: string; email?: string };
    return (user.email || user.login || "").trim();
  } catch {
    return "";
  }
}

function normalizeTokenExpiry(expiresIn?: number): Date {
  if (typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0) {
    return new Date(Date.now() + expiresIn * 1000);
  }

  return new Date("2100-01-01T00:00:00.000Z");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizeCopilotTierValue(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim().toLowerCase().replace(/_/g, "-");
  if (!normalized) return "";

  if (normalized === "pro-plus" || normalized === "proplus") return "pro+";
  if (normalized === "free-tier" || normalized === "free-limited-copilot") return "free";
  if (normalized === "education" || normalized === "educational" || normalized === "free-educational-quota" || normalized === "edu") return "student";
  return normalized;
}

function copilotPremiumEntitlement(payload: CopilotInternalUserResponse): number | null {
  const snapshots = asRecord(payload.quota_snapshots);
  const premium = asRecord(snapshots?.premium_interactions);
  return toFiniteNumber(premium?.entitlement);
}

function normalizeCopilotAccountTier(payload: CopilotInternalUserResponse): string | undefined {
  const sku = normalizeCopilotTierValue(payload.access_type_sku);
  if (sku.includes("education") || sku.includes("student")) return "student";
  if (sku.includes("free")) return "free";
  if (sku.includes("enterprise")) return "enterprise";
  if (sku.includes("business")) return "business";
  if (sku === "pro+") return "pro+";
  if (sku === "pro" || sku.includes("-pro-")) return "pro";

  const plan = normalizeCopilotTierValue(payload.copilot_plan);
  switch (plan) {
    case "free":
    case "student":
    case "pro":
    case "pro+":
    case "business":
    case "enterprise":
      return plan;
  }

  const entitlement = copilotPremiumEntitlement(payload);
  if (entitlement === 50) return "free";
  if (entitlement === 1500) return "pro+";
  if (entitlement === 1000) return "enterprise";
  if (entitlement === 300) return "pro";

  return undefined;
}

async function fetchCopilotTier(accessToken: string): Promise<string | undefined> {
  try {
    const response = await fetchInternalProvider(`${GITHUB_API_BASE_URL}/copilot_internal/user`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...COPILOT_INTERNAL_HEADERS,
      },
      cache: "no-store",
    });

    if (!response.ok) return undefined;
    return normalizeCopilotAccountTier((await response.json()) as CopilotInternalUserResponse);
  } catch {
    return undefined;
  }
}

export const copilotProvider = {
  async refreshToken(refreshToken: string): Promise<OAuthResult> {
    const response = await fetchInternalProvider(TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
      cache: "no-store",
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        formatProviderHttpError("Copilot", response, errorText, {
          endpointLabel: "token refresh endpoint",
        })
      );
    }

    const tokenData = (await response.json()) as CopilotTokenResponse;
    if (!tokenData.access_token) {
      throw new Error(tokenData.error_description || tokenData.error || "Missing access token");
    }

    const [identity, tier] = await Promise.all([
      fetchCopilotIdentity(tokenData.access_token),
      fetchCopilotTier(tokenData.access_token),
    ]);
    return {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || refreshToken,
      expiresAt: normalizeTokenExpiry(tokenData.expires_in),
      email: identity,
      ...(tier ? { tier } : {}),
    };
  },

  async getValidCredentials(account: CredentialAccount): Promise<string> {
    let accessToken = decrypt(account.accessToken);
    const refreshTokenValue = decrypt(account.refreshToken);

    if (isTokenExpired(account.expiresAt) && refreshTokenValue) {
      try {
        const refreshed = await copilotProvider.refreshToken(refreshTokenValue);

        await db
          .update(providerAccount)
          .set({
            accessToken: encrypt(refreshed.accessToken),
            refreshToken: encrypt(refreshed.refreshToken || refreshTokenValue),
            expiresAt: refreshed.expiresAt,
            ...(refreshed.email ? { email: refreshed.email } : {}),
            ...(refreshed.tier ? { tier: refreshed.tier } : {}),
          })
          .where(eq(providerAccount.id, account.id));

        accessToken = refreshed.accessToken;
      } catch (error) {
        console.error(`Failed to refresh Copilot token for account ${account.id}:`, error);
        if (new Date() >= account.expiresAt) {
          throw error;
        }
      }
    }

    return accessToken;
  },
};

export async function initiateCopilotDeviceCodeFlow(): Promise<{
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  verificationUrlComplete: string;
  expiresIn: number;
  interval: number;
}> {
  const response = await fetchInternalProvider(DEVICE_CODE_ENDPOINT, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      scope: SCOPE,
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      formatProviderHttpError("Copilot", response, errorText, {
        endpointLabel: "device code endpoint",
      })
    );
  }

  const data = (await response.json()) as CopilotDeviceCodeResponse;
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUrl: data.verification_uri,
    verificationUrlComplete: data.verification_uri_complete || data.verification_uri,
    expiresIn: data.expires_in || DEVICE_CODE_EXPIRY,
    interval: data.interval || POLLING_INTERVAL,
  };
}

export async function pollCopilotDeviceCodeAuthorization(
  deviceCode: string
): Promise<OAuthResult | { pending: true; retryAfterSeconds?: number } | { error: string }> {
  const response = await fetchInternalProvider(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    const errorText = await response.text();
    return {
      error: formatProviderHttpError("Copilot", response, errorText, {
        endpointLabel: "auth polling endpoint",
      }),
    };
  }

  const data = (await response.json()) as CopilotTokenResponse;
  if (data.access_token) {
    const [identity, tier] = await Promise.all([
      fetchCopilotIdentity(data.access_token),
      fetchCopilotTier(data.access_token),
    ]);
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || data.access_token,
      expiresAt: normalizeTokenExpiry(data.expires_in),
      email: identity,
      ...(tier ? { tier } : {}),
    };
  }

  if (data.error === "authorization_pending") {
    return { pending: true };
  }

  if (data.error === "slow_down") {
    const serverInterval = data.interval ?? POLLING_INTERVAL + 5;
    return {
      pending: true,
      retryAfterSeconds: serverInterval + POLLING_SAFETY_MARGIN_SECONDS,
    };
  }

  if (data.error === "expired_token") {
    return { error: "Device code expired. Please start again." };
  }

  if (data.error === "access_denied") {
    return { error: "Authorization was denied by the user." };
  }

  return {
    error: data.error_description || data.error || "Unknown authentication error",
  };
}
