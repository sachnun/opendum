import { Effect } from "effect";
import { fetchExternalEffect } from "#web/lib/external.js";
import { fromPromise } from "#web/lib/task.js";
import { unavailable } from "#web/errors.js";
import { httpError } from "../provider-http-errors.js";
import type { OAuthResult } from "../types.js";
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
} from "./constants.js";

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

function errorText(response: Response, body: string, endpointLabel: string): string {
  return httpError("Cline", response, body, { endpointLabel });
}

function readText(response: Response) {
  return fromPromise(() => response.text().catch(() => ""), "Failed to read Cline response");
}

function readJson<T>(response: Response, fallback: T) {
  return fromPromise(
    async () => ((await response.json().catch(() => fallback)) as T),
    "Failed to read Cline response"
  );
}

export const startDeviceFlow = Effect.fn("cline.initiateDeviceCodeFlow")(function* () {
  const response = yield* fetchExternalEffect(`${WORKOS_BASE_URL}${DEVICE_AUTHORIZE_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `client_id=${CLIENT_ID}`,
    cache: "no-store",
  });

  if (!response.ok) {
    const body = yield* readText(response);
    return yield* unavailable(errorText(response, body, "device code endpoint"));
  }

  const data = yield* readJson<CodeResponse>(response, {});
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
  const response = yield* fetchExternalEffect(`${CLINE_BASE_URL}${CLINE_REGISTER_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accessToken: workosAccessToken, refreshToken: workosRefreshToken }),
    cache: "no-store",
  });

  if (!response.ok) {
    const body = yield* readText(response);
    return yield* unavailable(errorText(response, body, "registration endpoint"));
  }

  const data = yield* readJson<ClineRegisterResponse>(response, {});
  if (!data.data?.accessToken || !data.data?.refreshToken) {
    return yield* unavailable("Cline registration returned an incomplete session");
  }

  return { accessToken: `workos:${data.data.accessToken}`, refreshToken: data.data.refreshToken };
});

export const pollDeviceAuth = Effect.fn("cline.pollDeviceCodeAuthorization")(
  function* (deviceCode: string) {
    const response = yield* fetchExternalEffect(`${WORKOS_BASE_URL}${DEVICE_AUTHENTICATE_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=${encodeURIComponent(deviceCode)}&client_id=${CLIENT_ID}`,
      cache: "no-store",
    });

    const data = yield* readJson<AuthResponse>(response, {});

    if (data.error === "authorization_pending") return { pending: true as const };
    if (data.error === "slow_down") return { pending: true as const, retryAfterSeconds: 5 };
    if (data.error === "expired_token") return { error: "Cline device code expired. Please try again." };
    if (data.error === "access_denied") return { error: "Cline authorization was denied. Please try again." };

    if (!data.access_token) {
      if (!response.ok) {
        const body = yield* readText(response);
        return { error: errorText(response, body, "device authorization endpoint") };
      }
      return { pending: true as const };
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
