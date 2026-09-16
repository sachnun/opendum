import { fetchInternalProvider } from "../../proxy/internal-relay.js";
import type { OAuthResult } from "../types.js";

const UPSTREAM_BASE = "https://freebuff.com";
const API_KEY_ACCOUNT_EXPIRY = new Date("2100-01-01T00:00:00.000Z");
const DEVICE_CODE_EXPIRY_SECONDS = 300;
const POLLING_INTERVAL_SECONDS = 3;

interface FreebuffLoginState {
  fingerprintId: string;
  fingerprintHash: string;
  expiresAt: string;
}

interface FreebuffCodeResponse {
  loginUrl?: string;
  fingerprintHash?: string;
  expiresAt?: string | number;
}

interface FreebuffStatusResponse {
  status?: string;
  user?: {
    id?: string;
    email?: string;
    name?: string;
    authToken?: string;
    fingerprintId?: string;
    fingerprintHash?: string;
  };
}

export interface FreebuffInitiateResult {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  verificationUrlComplete: string;
  expiresIn: number;
  interval: number;
}

function generateFingerprintId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `enhanced-${Buffer.from(bytes).toString("base64url")}`;
}

function expiresAtValue(value: string | number | undefined): string {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return String(Date.now() + DEVICE_CODE_EXPIRY_SECONDS * 1000);
}

export async function initiateFreebuffDeviceCodeFlow(): Promise<FreebuffInitiateResult> {
  const fingerprintId = generateFingerprintId();
  const response = await fetchInternalProvider(`${UPSTREAM_BASE}/api/auth/cli/code`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ fingerprintId }),
    cache: "no-store",
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Freebuff login request failed (${response.status}): ${body}`);
  }
  const data = (await response.json().catch(() => ({}))) as FreebuffCodeResponse;
  const loginUrl = data.loginUrl ?? "";
  if (!loginUrl) throw new Error("Freebuff login response is missing the login URL");
  const state: FreebuffLoginState = {
    fingerprintId,
    fingerprintHash: data.fingerprintHash ?? fingerprintId,
    expiresAt: expiresAtValue(data.expiresAt),
  };
  return {
    deviceCode: JSON.stringify(state),
    userCode: "",
    verificationUrl: loginUrl,
    verificationUrlComplete: loginUrl,
    expiresIn: DEVICE_CODE_EXPIRY_SECONDS,
    interval: POLLING_INTERVAL_SECONDS,
  };
}

export async function pollFreebuffDeviceCodeAuthorization(
  deviceCode: string
): Promise<OAuthResult | { pending: true; retryAfterSeconds?: number } | { error: string }> {
  let state: FreebuffLoginState;
  try {
    state = JSON.parse(deviceCode) as FreebuffLoginState;
  } catch {
    return { error: "Freebuff login state is invalid. Please restart authentication." };
  }

  const params = new URLSearchParams({
    fingerprintId: state.fingerprintId,
    fingerprintHash: state.fingerprintHash,
    expiresAt: state.expiresAt,
  });
  const response = await fetchInternalProvider(`${UPSTREAM_BASE}/api/auth/cli/status?${params.toString()}`, {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
  });

  if (response.status === 401) return { pending: true, retryAfterSeconds: POLLING_INTERVAL_SECONDS };
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    return { error: `Freebuff login status check failed (${response.status}): ${body}` };
  }
  const data = (await response.json().catch(() => ({}))) as FreebuffStatusResponse;
  const user = data.user;
  if (user?.authToken) {
    return {
      accessToken: user.authToken,
      refreshToken: user.authToken,
      expiresAt: API_KEY_ACCOUNT_EXPIRY,
      email: user.email ?? "",
      accountId: user.id ?? "",
    };
  }

  switch (data.status) {
    case "success":
      return { error: "Freebuff login succeeded but no account was returned." };
    case "timeout":
      return { error: "Freebuff login session expired. Please try again." };
    case "pending":
    case "":
    case undefined:
      return { pending: true, retryAfterSeconds: POLLING_INTERVAL_SECONDS };
    default:
      return { pending: true, retryAfterSeconds: POLLING_INTERVAL_SECONDS };
  }
}
