import { fetchInternalProvider } from "../../proxy/internal-relay.js";
import { formatProviderHttpError } from "../provider-http-errors.js";
import type { OAuthResult } from "../types.js";
import {
  AUTHORIZE_BASE_URL,
  CLIENT_ID,
  DEVICE_AUTHORIZE_PATH,
  DEVICE_CODE_EXPIRY_SECONDS,
  DEVICE_TOKEN_POLL_PATH,
  DEVICE_TOKEN_REFRESH_PATH,
  OPENAPI_BASE_URL,
  PKCE_VERIFIER_ALPHABET,
  PKCE_VERIFIER_MAX_LENGTH,
  PKCE_VERIFIER_MIN_LENGTH,
  POLLING_INTERVAL_SECONDS,
  USERINFO_PATH,
} from "./constants.js";

// PKCE verifier generation mirrors qodercli's aus(): a random length in
// [43, 128] of characters drawn from the RFC 7636 unreserved set.
function generateVerifier(): string {
  const minLength = PKCE_VERIFIER_MIN_LENGTH;
  const span = PKCE_VERIFIER_MAX_LENGTH - minLength + 1;
  const length = minLength + Math.floor(span * Math.random());
  const random = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (let i = 0; i < length; i += 1) {
    const byte = random[i] ?? 0;
    out += PKCE_VERIFIER_ALPHABET[byte % PKCE_VERIFIER_ALPHABET.length] ?? "";
  }
  return out;
}

// qodercli hashes the verifier STRING (not the raw random bytes) before
// base64url-encoding it. Mirror that exactly or the server rejects the
// challenge.
async function computeChallenge(verifier: string): Promise<string> {
  const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function generateUUID(): string {
  return crypto.randomUUID();
}

interface QoderDevicePollResponse {
  token?: string;
  refresh_token?: string;
  expires_at?: string;
  expires_in?: number;
  refresh_token_expires_at?: string;
  user_id?: string;
}

interface QoderDeviceRefreshResponse {
  device_token?: string;
  token?: string;
  refresh_token?: string;
  expires_at?: string;
  expires_in?: number;
}

interface QoderUserInfo {
  username?: string;
  email?: string;
  name?: string;
}

export interface QoderInitiateResult {
  authUrl: string;
  // Qoder has no short user_code (consent happens entirely in the browser),
  // but the dashboard device-code UI expects a non-empty placeholder.
  userCode: string;
  // Internal state carried through to the poll step.
  codeVerifier: string;
  nonce: string;
  machineId: string;
  expiresIn: number;
  interval: number;
}

function parseExpiry(value: string | number | undefined, fallbackSeconds: number): Date {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    if (value > 10_000_000_000) return new Date(value);
    return new Date(value * 1000);
  }
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed);
  }
  return new Date(Date.now() + fallbackSeconds * 1000);
}

export async function initiateQoderDeviceCodeFlow(): Promise<QoderInitiateResult> {
  const verifier = generateVerifier();
  const challenge = await computeChallenge(verifier);
  const nonce = generateUUID();
  const machineId = generateUUID();

  const params = new URLSearchParams({
    challenge,
    challenge_method: "S256",
    nonce,
    machine_id: machineId,
    client_id: CLIENT_ID,
  });
  const authUrl = `${AUTHORIZE_BASE_URL}${DEVICE_AUTHORIZE_PATH}?${params.toString()}`;

  return {
    authUrl,
    userCode: "",
    codeVerifier: verifier,
    nonce,
    machineId,
    expiresIn: DEVICE_CODE_EXPIRY_SECONDS,
    interval: POLLING_INTERVAL_SECONDS,
  };
}

export async function pollQoderDeviceCodeAuthorization(
  codeVerifier: string,
  nonce: string
): Promise<OAuthResult | { pending: true; retryAfterSeconds?: number } | { error: string }> {
  const params = new URLSearchParams({
    nonce,
    verifier: codeVerifier,
    challenge_method: "S256",
  });
  const url = `${OPENAPI_BASE_URL}${DEVICE_TOKEN_POLL_PATH}?${params.toString()}`;

  const response = await fetchInternalProvider(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
  });

  // 404 while the user has not yet completed consent -> pending.
  if (response.status === 404) {
    return { pending: true };
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    if (response.status === 401 || response.status === 403) {
      return { error: "Qoder authorization was rejected. Please try again." };
    }
    return {
      error: formatProviderHttpError("Qoder", response, errorText, {
        endpointLabel: "device token polling endpoint",
      }),
    };
  }

  const data = (await response.json().catch(() => ({}))) as QoderDevicePollResponse;
  if (!data.token) {
    return { pending: true };
  }

  const expiresAt = parseExpiry(data.expires_at ?? data.expires_in, 86400);
  const identity = await fetchQoderIdentity(data.token);
  return {
    accessToken: data.token,
    refreshToken: data.refresh_token || data.token,
    expiresAt,
    email: identity,
    // Carry the Qoder user_id through accountId so the proxy can build
    // COSY-signed requests. account-auth rejoins it with the machine_id.
    accountId: data.user_id || "",
  };
}

export async function refreshQoderDeviceToken(refreshToken: string): Promise<OAuthResult> {
  const response = await fetchInternalProvider(`${OPENAPI_BASE_URL}${DEVICE_TOKEN_REFRESH_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
    cache: "no-store",
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      formatProviderHttpError("Qoder", response, errorText, {
        endpointLabel: "device token refresh endpoint",
      })
    );
  }

  const data = (await response.json().catch(() => ({}))) as QoderDeviceRefreshResponse;
  const token = data.device_token || data.token;
  if (!token) throw new Error("Qoder token refresh returned empty token");

  const expiresAt = parseExpiry(data.expires_at ?? data.expires_in, 86400);
  const email = await fetchQoderIdentity(token);
  return {
    accessToken: token,
    refreshToken: data.refresh_token || refreshToken,
    expiresAt,
    email,
  };
}

async function fetchQoderIdentity(accessToken: string): Promise<string> {
  try {
    const response = await fetchInternalProvider(`${OPENAPI_BASE_URL}${USERINFO_PATH}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) return "";
    const user = (await response.json().catch(() => ({}))) as QoderUserInfo;
    return (user.email || user.username || user.name || "").trim();
  } catch {
    return "";
  }
}
