import { Effect } from "effect";

import { OAuthClient } from "@opendum/providers/auth/client";
import type { AuthRuntime } from "@opendum/providers/auth/runtime";
import { failedResult, pendingResult, ProviderResponse } from "@opendum/providers/auth/response";
import type { OAuthResult } from "@opendum/providers/auth/result";
import {
  ACCESS_TTL,
  AUTH_START_PATH,
  AUTH_TOKEN_PATH,
  CONTROL_PLANE_URL,
  DEVICE_EXPIRY,
  DEVICE_NAME,
  POLLING_INTERVAL_SECONDS,
} from "@opendum/providers/auth/zro/constants";

interface ZroStartResponse {
  deviceCode?: string;
  userCode?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  expiresIn?: number;
  interval?: number;
  error?: string;
}

interface ZroTokenResponse {
  status?: string;
  encryptedToken?: string;
  error?: string;
}

export interface ZroInitiateResult {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  verificationUrlComplete: string;
  expiresIn: number;
  interval: number;
  codeVerifier: string;
}

const JSON_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json",
};

const PEM_WIDTH = 64;

function toPem(label: string, bytes: ArrayBuffer): string {
  const base64 = btoa(String.fromCharCode(...new Uint8Array(bytes)));
  const lines = base64.match(new RegExp(`.{1,${PEM_WIDTH}}`, "g")) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

function pemBody(pem: string): string {
  return pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
}

export function generateDeviceKey(): Effect.Effect<{ publicKey: string; privateKey: string }> {
  return Effect.tryPromise({
    try: async () => {
      const pair = await crypto.subtle.generateKey(
        {
          name: "RSA-OAEP",
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: "SHA-256",
        },
        true,
        ["encrypt", "decrypt"]
      );
      const spki = await crypto.subtle.exportKey("spki", pair.publicKey);
      const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
      return { publicKey: toPem("PUBLIC KEY", spki), privateKey: toPem("PRIVATE KEY", pkcs8) };
    },
    catch: (cause) => new Error("Failed to generate the Zro device key", { cause }),
  }).pipe(Effect.orDie);
}

export function decryptDeviceToken(privateKeyPem: string, encryptedToken: string): Effect.Effect<string, Error> {
  return Effect.tryPromise({
    try: async () => {
      const der = Uint8Array.from(atob(pemBody(privateKeyPem)), (char) => char.charCodeAt(0));
      const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["decrypt"]);
      const sealed = Uint8Array.from(atob(encryptedToken), (char) => char.charCodeAt(0));
      const plain = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, key, sealed);
      return new TextDecoder().decode(plain).trim();
    },
    catch: (cause) => new Error("Could not decrypt the Zro credential for this device", { cause }),
  });
}

class ZroClient extends OAuthClient {
  constructor(runtime: AuthRuntime) {
    super({ provider: "zro", label: "Zro" }, runtime);
  }
}

export function zroAuth(runtime: AuthRuntime) {
  const response = new ProviderResponse("Zro");
  const client = new ZroClient(runtime);

  const startDeviceFlow = Effect.fn("zro.initiateDeviceCodeFlow")(function* () {
    const key = yield* generateDeviceKey();
    const result = yield* client.call(`${CONTROL_PLANE_URL}${AUTH_START_PATH}`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ publicKey: key.publicKey, deviceName: DEVICE_NAME }),
      cache: "no-store",
    });
    if (!result.ok) {
      const body = yield* response.text(result);
      return yield* Effect.fail(client.fail(response.failure(result, body, "device code endpoint")));
    }

    const data = yield* response.jsonOr<ZroStartResponse>(result, {});
    const deviceCode = data.deviceCode?.trim() ?? "";
    const userCode = data.userCode?.trim() ?? "";
    const verificationUrl = data.verificationUri?.trim() ?? "";
    if (!deviceCode || !userCode || !verificationUrl) {
      return yield* Effect.fail(client.fail("Zro device code response is missing required fields"));
    }

    return {
      deviceCode,
      userCode,
      verificationUrl,
      verificationUrlComplete: data.verificationUriComplete?.trim() || verificationUrl,
      expiresIn: data.expiresIn && data.expiresIn > 0 ? data.expiresIn : DEVICE_EXPIRY,
      interval: data.interval && data.interval > 0 ? data.interval : POLLING_INTERVAL_SECONDS,
      codeVerifier: key.privateKey,
    } satisfies ZroInitiateResult;
  });

  const pollDeviceAuth = Effect.fn("zro.pollDeviceCodeAuthorization")(
    function* (deviceCode: string, _userCode: string, privateKey: string) {
      const code = deviceCode.trim();
      if (!code) return failedResult("Zro device code is missing. Please try again.");
      if (!privateKey.trim()) {
        return failedResult("Zro device key is missing. Please start the login again.");
      }

      const result = yield* client.call(`${CONTROL_PLANE_URL}${AUTH_TOKEN_PATH}`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ deviceCode: code }),
        cache: "no-store",
      });
      const data = yield* response.jsonOr<ZroTokenResponse>(result, {});

      if (result.status === 202) return pendingResult();
      if (!result.ok) {
        if (result.status === 404 || result.status === 410) {
          return failedResult("Zro device code expired. Please try again.");
        }
        const body = yield* response.text(result);
        return failedResult(response.failure(result, body, "device token polling endpoint"));
      }

      const encryptedToken = data.encryptedToken?.trim() ?? "";
      if (!encryptedToken) return pendingResult();

      const decrypted = yield* decryptDeviceToken(privateKey, encryptedToken).pipe(
        Effect.catch(() => Effect.succeed(""))
      );
      if (!decrypted) {
        return failedResult("Could not decrypt the Zro credential. Please start the login again.");
      }

      return {
        accessToken: decrypted,
        refreshToken: decrypted,
        expiresAt: new Date(Date.now() + ACCESS_TTL * 1000),
        email: `zro-${runtime.hash(decrypted).slice(0, 16)}`,
      } satisfies OAuthResult;
    }
  );

  return { startDeviceFlow, pollDeviceAuth };
}
