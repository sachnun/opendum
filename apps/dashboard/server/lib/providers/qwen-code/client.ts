import { fetchInternalProvider } from "../../proxy/internal-relay.js";
import type { OAuthResult } from "../types.js";
import { formatProviderHttpError } from "../provider-http-errors.js";
import { CLIENT_ID, DEVICE_CODE_ENDPOINT, SCOPE, TOKEN_ENDPOINT } from "./constants.js";

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

function generateCodeVerifier(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const base64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function initiateDeviceCodeFlow(): Promise<{
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  verificationUrlComplete: string;
  expiresIn: number;
  interval: number;
  codeVerifier: string;
}> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  const response = await fetchInternalProvider(DEVICE_CODE_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      scope: SCOPE,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(
      formatProviderHttpError("Qwen Code", response, error, {
        endpointLabel: "device code endpoint",
      })
    );
  }

  const data = (await response.json()) as DeviceCodeResponse;
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUrl: data.verification_uri,
    verificationUrlComplete: data.verification_uri_complete,
    expiresIn: data.expires_in,
    interval: data.interval,
    codeVerifier,
  };
}

export async function pollDeviceCodeAuthorization(
  deviceCode: string,
  codeVerifier: string
): Promise<OAuthResult | { pending: true } | { error: string }> {
  const response = await fetchInternalProvider(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
      client_id: CLIENT_ID,
      code_verifier: codeVerifier,
    }),
  });

  if (response.status === 200) {
    const tokens = (await response.json()) as TokenResponse;
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
      email: "",
    };
  }

  if (response.status === 400) {
    const errorData = (await response.json()) as { error?: string; error_description?: string };
    const errorType = errorData.error;

    if (errorType === "authorization_pending" || errorType === "slow_down") {
      return { pending: true };
    }
    if (errorType === "expired_token") {
      return { error: "Device code expired. Please start again." };
    }
    if (errorType === "access_denied") {
      return { error: "Authorization was denied by the user." };
    }

    return { error: errorData.error_description || errorType || "Unknown error" };
  }

  const error = await response.text();
  return {
    error: formatProviderHttpError("Qwen Code", response, error, {
      endpointLabel: "auth polling endpoint",
    }),
  };
}
