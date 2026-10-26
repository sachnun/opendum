import { Effect } from "effect";
import { fetchExternalEffect } from "@opendum/api/web/lib/external";
import { unavailable } from "@opendum/api/web/errors";
import { failedResult, pendingResult, ProviderResponse } from "@opendum/api/web/lib/providers/provider-response";
import type { OAuthResult } from "@opendum/api/web/lib/providers/types";
import {
  ACCESS_TTL,
  CLIENT_ID,
  CLINE_BASE_URL,
  CLINE_REGISTER_PATH,
  DEVICE_AUTHENTICATE_PATH,
  DEVICE_AUTHORIZE_PATH,
  DEVICE_EXPIRY,
  POLLING_INTERVAL_SECONDS,
  WORKOS_BASE_URL,
} from "@opendum/api/web/lib/providers/cline/constants";

interface CodeResponse {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
}

interface AuthResponse {
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

const response = new ProviderResponse("Cline");

export const startDeviceFlow = Effect.fn("cline.initiateDeviceCodeFlow")(function* () {
  const result = yield* fetchExternalEffect(`${WORKOS_BASE_URL}${DEVICE_AUTHORIZE_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `client_id=${CLIENT_ID}`,
    cache: "no-store",
  });

  if (!result.ok) {
    const body = yield* response.text(result);
    return yield* unavailable(response.failure(result, body, "device code endpoint"));
  }

  const data = yield* response.jsonOr<CodeResponse>(result, {});
  if (!data.device_code || !data.verification_uri_complete) {
    return yield* unavailable("Cline device code response is missing required fields");
  }

  return {
    deviceCode: data.device_code,
    userCode: data.user_code ?? "",
    verificationUrl: data.verification_uri ?? data.verification_uri_complete,
    verificationUrlComplete: data.verification_uri_complete,
    expiresIn: data.expires_in ?? DEVICE_EXPIRY,
    interval: data.interval ?? POLLING_INTERVAL_SECONDS,
  } satisfies ClineInitiateResult;
});

const registerWithCline = Effect.fn("cline.register")(function* (
  workosAccessToken: string,
  workosRefreshToken: string
) {
  const result = yield* fetchExternalEffect(`${CLINE_BASE_URL}${CLINE_REGISTER_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accessToken: workosAccessToken, refreshToken: workosRefreshToken }),
    cache: "no-store",
  });

  if (!result.ok) {
    const body = yield* response.text(result);
    return yield* unavailable(response.failure(result, body, "registration endpoint"));
  }

  const data = yield* response.jsonOr<ClineRegisterResponse>(result, {});
  if (!data.data?.accessToken || !data.data?.refreshToken) {
    return yield* unavailable("Cline registration returned an incomplete session");
  }

  return { accessToken: `workos:${data.data.accessToken}`, refreshToken: data.data.refreshToken };
});

export const pollDeviceAuth = Effect.fn("cline.pollDeviceCodeAuthorization")(
  function* (deviceCode: string) {
    const result = yield* fetchExternalEffect(`${WORKOS_BASE_URL}${DEVICE_AUTHENTICATE_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=${encodeURIComponent(deviceCode)}&client_id=${CLIENT_ID}`,
      cache: "no-store",
    });

    const data = yield* response.jsonOr<AuthResponse>(result, {});

    if (data.error === "authorization_pending") return pendingResult();
    if (data.error === "slow_down") return pendingResult(5);
    if (data.error === "expired_token") return failedResult("Cline device code expired. Please try again.");
    if (data.error === "access_denied") return failedResult("Cline authorization was denied. Please try again.");

    if (!data.access_token) {
      if (!result.ok) {
        const body = yield* response.text(result);
        return failedResult(response.failure(result, body, "device authorization endpoint"));
      }
      return pendingResult();
    }

    const registered = yield* registerWithCline(data.access_token, data.refresh_token ?? "");
    return {
      accessToken: registered.accessToken,
      refreshToken: registered.refreshToken,
      expiresAt: new Date(Date.now() + ACCESS_TTL * 1000),
      email: data.user?.email ?? "",
    } satisfies OAuthResult;
  }
);
