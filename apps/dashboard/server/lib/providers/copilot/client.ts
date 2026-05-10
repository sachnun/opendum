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

const POLLING_SAFETY_MARGIN_SECONDS = 3;

function isTokenExpired(expiresAt: Date): boolean {
  const bufferMs = REFRESH_BUFFER_SECONDS * 1000;
  return Date.now() > expiresAt.getTime() - bufferMs;
}

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

    const identity = await fetchCopilotIdentity(tokenData.access_token);
    return {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || refreshToken,
      expiresAt: normalizeTokenExpiry(tokenData.expires_in),
      email: identity,
    };
  },

  async getValidCredentials(account: ProviderAccount): Promise<string> {
    let accessToken = decrypt(account.accessToken);
    const refreshTokenValue = decrypt(account.refreshToken);

    if (isTokenExpired(account.expiresAt) && refreshTokenValue) {
      try {
        const refreshed = await copilotProvider.refreshToken(refreshTokenValue);

        await db
          .update(providerAccount)
          .set({
            accessToken: encrypt(refreshed.accessToken),
            refreshToken: encrypt(refreshed.refreshToken),
            expiresAt: refreshed.expiresAt,
            ...(refreshed.email ? { email: refreshed.email } : {}),
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
    const identity = await fetchCopilotIdentity(data.access_token);
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || data.access_token,
      expiresAt: normalizeTokenExpiry(data.expires_in),
      email: identity,
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
