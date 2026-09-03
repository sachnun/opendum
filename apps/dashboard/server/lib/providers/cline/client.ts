import { fetchInternalProvider } from "../../proxy/internal-relay.js";
import { formatProviderHttpError } from "../provider-http-errors.js";
import type { OAuthResult } from "../types.js";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  CLIENT_ID,
  CLINE_BASE_URL,
  CLINE_REFRESH_PATH,
  CLINE_REGISTER_PATH,
  DEVICE_AUTHENTICATE_PATH,
  DEVICE_AUTHORIZE_PATH,
  DEVICE_CODE_EXPIRY_SECONDS,
  POLLING_INTERVAL_SECONDS,
  WORKOS_BASE_URL,
} from "./constants.js";

interface ClineDeviceCodeResponse {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
}

interface ClineDeviceAuthenticateResponse {
  access_token?: string;
  refresh_token?: string;
  error?: string;
  user?: { email?: string };
}

interface ClineRegisterResponse {
  data?: { accessToken?: string; refreshToken?: string };
}

export interface ClineInitiateResult {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  verificationUrlComplete: string;
  expiresIn: number;
  interval: number;
}

function formatClineError(response: Response, body: string, endpointLabel: string): string {
  return formatProviderHttpError("Cline", response, body, { endpointLabel });
}

export async function initiateClineDeviceCodeFlow(): Promise<ClineInitiateResult> {
  const response = await fetchInternalProvider(`${WORKOS_BASE_URL}${DEVICE_AUTHORIZE_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `client_id=${CLIENT_ID}`,
    cache: "no-store",
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(formatClineError(response, body, "device code endpoint"));
  }

  const data = (await response.json().catch(() => ({}))) as ClineDeviceCodeResponse;
  if (!data.device_code || !data.verification_uri_complete) {
    throw new Error("Cline device code response is missing required fields");
  }

  return {
    deviceCode: data.device_code,
    userCode: data.user_code ?? "",
    verificationUrl: data.verification_uri ?? data.verification_uri_complete,
    verificationUrlComplete: data.verification_uri_complete,
    expiresIn: data.expires_in ?? DEVICE_CODE_EXPIRY_SECONDS,
    interval: data.interval ?? POLLING_INTERVAL_SECONDS,
  };
}

export async function pollClineDeviceCodeAuthorization(
  deviceCode: string
): Promise<OAuthResult | { pending: true; retryAfterSeconds?: number } | { error: string }> {
  const response = await fetchInternalProvider(`${WORKOS_BASE_URL}${DEVICE_AUTHENTICATE_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=${encodeURIComponent(deviceCode)}&client_id=${CLIENT_ID}`,
    cache: "no-store",
  });

  const data = (await response.json().catch(() => ({}))) as ClineDeviceAuthenticateResponse;

  if (data.error === "authorization_pending") return { pending: true };
  if (data.error === "slow_down") return { pending: true, retryAfterSeconds: 5 };
  if (data.error === "expired_token") return { error: "Cline device code expired. Please try again." };
  if (data.error === "access_denied") return { error: "Cline authorization was denied. Please try again." };

  if (!data.access_token) {
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return { error: formatClineError(response, body, "device authorization endpoint") };
    }
    return { pending: true };
  }

  const registered = await registerWithCline(data.access_token, data.refresh_token ?? "");
  return {
    accessToken: registered.accessToken,
    refreshToken: registered.refreshToken,
    expiresAt: new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000),
    email: data.user?.email ?? "",
  };
}

async function registerWithCline(
  workosAccessToken: string,
  workosRefreshToken: string
): Promise<{ accessToken: string; refreshToken: string }> {
  const response = await fetchInternalProvider(`${CLINE_BASE_URL}${CLINE_REGISTER_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accessToken: workosAccessToken, refreshToken: workosRefreshToken }),
    cache: "no-store",
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(formatClineError(response, body, "registration endpoint"));
  }

  const data = (await response.json().catch(() => ({}))) as ClineRegisterResponse;
  if (!data.data?.accessToken || !data.data?.refreshToken) {
    throw new Error("Cline registration returned an incomplete session");
  }

  return { accessToken: `workos:${data.data.accessToken}`, refreshToken: data.data.refreshToken };
}

export async function refreshClineToken(refreshToken: string): Promise<OAuthResult> {
  const response = await fetchInternalProvider(`${CLINE_BASE_URL}${CLINE_REFRESH_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken, grantType: "refresh_token" }),
    cache: "no-store",
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(formatClineError(response, body, "token refresh endpoint"));
  }

  const data = (await response.json().catch(() => ({}))) as ClineRegisterResponse;
  if (!data.data?.accessToken || !data.data?.refreshToken) {
    throw new Error("Cline token refresh returned an incomplete session");
  }

  return {
    accessToken: `workos:${data.data.accessToken}`,
    refreshToken: data.data.refreshToken,
    expiresAt: new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000),
    email: "",
  };
}