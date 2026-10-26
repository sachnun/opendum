import { Effect } from "effect";

import { OAuthClient } from "@opendum/providers/auth/client";
import type { AuthRuntime } from "@opendum/providers/auth/runtime";
import { failedResult, pendingResult, ProviderResponse } from "@opendum/providers/auth/response";
import type { OAuthResult } from "@opendum/providers/auth/result";
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
} from "@opendum/providers/auth/cline/constants";

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

const FORM_HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded",
  Accept: "application/json",
};

const JSON_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json",
};

class ClineClient extends OAuthClient {
  constructor(runtime: AuthRuntime) {
    super({ provider: "cline", label: "Cline" }, runtime);
  }
}

export function clineAuth(runtime: AuthRuntime) {
  const response = new ProviderResponse("Cline");
  const client = new ClineClient(runtime);

  const startDeviceFlow = Effect.fn("cline.initiateDeviceCodeFlow")(function* () {
    const data = yield* client.decode<CodeResponse>(
      {
        url: `${WORKOS_BASE_URL}${DEVICE_AUTHORIZE_PATH}`,
        endpoint: "device code endpoint",
        init: {
          method: "POST",
          headers: FORM_HEADERS,
          body: `client_id=${CLIENT_ID}`,
          cache: "no-store",
        },
      },
      (payload) => (payload as CodeResponse | null) ?? null
    );
    if (!data.device_code || !data.verification_uri_complete) {
      return yield* Effect.fail(client.fail("Cline device code response is missing required fields"));
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
    const data = yield* client.decode<ClineRegisterResponse>(
      {
        url: `${CLINE_BASE_URL}${CLINE_REGISTER_PATH}`,
        endpoint: "registration endpoint",
        init: {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ accessToken: workosAccessToken, refreshToken: workosRefreshToken }),
          cache: "no-store",
        },
      },
      (payload) => (payload as ClineRegisterResponse | null) ?? null
    );
    if (!data.data?.accessToken || !data.data?.refreshToken) {
      return yield* Effect.fail(client.fail("Cline registration returned an incomplete session"));
    }

    return { accessToken: `workos:${data.data.accessToken}`, refreshToken: data.data.refreshToken };
  });

  const pollDeviceAuth = Effect.fn("cline.pollDeviceCodeAuthorization")(
    function* (deviceCode: string) {
      const result = yield* client.call(`${WORKOS_BASE_URL}${DEVICE_AUTHENTICATE_PATH}`, {
        method: "POST",
        headers: FORM_HEADERS,
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

  return { startDeviceFlow, pollDeviceAuth };
}
