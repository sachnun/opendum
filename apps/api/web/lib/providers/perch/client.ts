import { Effect } from "effect";
import { fetchExternalEffect } from "#web/lib/external.js";
import { fromPromise } from "#web/lib/task.js";
import { unavailable } from "#web/errors.js";
import { formatProviderHttpError } from "../provider-http-errors.js";
import type { OAuthResult } from "../types.js";
import {
  PERCH_ACCOUNT_PATH,
  PERCH_APP_URL,
  PERCH_AUTH_CONFIG_PATH,
  PERCH_AUTH_TOKEN_PATH,
  PERCH_REDIRECT_URI,
  PERCH_STARTER_PLAN_CODE,
} from "./constants.js";

interface PerchAuthConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  providers?: string[];
  ok?: boolean;
}

interface PerchTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
  expires_in?: number;
  user?: { email?: string | null; id?: string };
}

interface PerchAccountSession {
  userId?: string;
  workspaceId?: string;
  planCode?: string;
  planName?: string;
  tierSelectionRequired?: boolean;
}

interface PerchAccountResponse {
  ok?: boolean;
  session?: PerchAccountSession;
}

function formatPerchError(response: Response, body: string, endpointLabel: string): string {
  return formatProviderHttpError("Perch", response, body, { endpointLabel });
}

function readText(response: Response) {
  return fromPromise(() => response.text().catch(() => ""), "Failed to read Perch response");
}

function readJson<T>(response: Response, fallback: T) {
  return fromPromise(
    async () => ((await response.json().catch(() => fallback)) as T),
    "Failed to read Perch response"
  );
}

const fetchPerchAuthConfig = Effect.fn("perch.authConfig")(function* () {
  const response = yield* fetchExternalEffect(`${PERCH_APP_URL}${PERCH_AUTH_CONFIG_PATH}`, {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) {
    const body = yield* readText(response);
    return yield* unavailable(formatPerchError(response, body, "auth config endpoint"));
  }
  const config = yield* readJson<Partial<PerchAuthConfig>>(response, {});
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    return yield* unavailable("Perch auth config is incomplete. Please try again later.");
  }
  return config as PerchAuthConfig;
});

function perchProviderId(config: PerchAuthConfig) {
  const enabled = (config.providers ?? []).filter((provider) => provider === "google" || provider === "github");
  if (enabled.length === 0) {
    return Effect.fail(unavailable("No supported Perch OAuth provider is enabled right now."));
  }
  return Effect.succeed(enabled.includes("google") ? "google" : "github");
}

const pkcePair = Effect.fn("perch.pkcePair")(function* () {
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  const verifier = base64UrlEncode(verifierBytes);
  const digest = yield* fromPromise(
    () => crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    "Failed to build Perch PKCE challenge"
  );
  return { verifier, challenge: base64UrlEncode(new Uint8Array(digest)) };
});

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function perchSupabaseUrl(config: PerchAuthConfig): string {
  return config.supabaseUrl.replace(/\/+$/, "");
}

function perchAuthHeaders(config: PerchAuthConfig): Record<string, string> {
  return {
    "Content-Type": "application/json",
    apikey: config.supabaseAnonKey,
    Authorization: `Bearer ${config.supabaseAnonKey}`,
    Accept: "application/json",
  };
}

export interface PerchInitiateResult {
  authUrl: string;
  codeVerifier: string;
  verificationUrl: string;
}

export const initiatePerchOAuth = Effect.fn("perch.initiateOAuth")(function* () {
  const config = yield* fetchPerchAuthConfig();
  const { verifier, challenge } = yield* pkcePair();
  const provider = yield* perchProviderId(config);
  const params = new URLSearchParams({
    provider,
    code_challenge: challenge,
    code_challenge_method: "s256",
    redirect_to: PERCH_REDIRECT_URI,
  });
  const authUrl = `${perchSupabaseUrl(config)}/auth/v1/authorize?${params.toString()}`;
  return { authUrl, codeVerifier: verifier, verificationUrl: authUrl } satisfies PerchInitiateResult;
});

const selectPerchStarterPlan = Effect.fn("perch.selectStarterPlan")(function* (
  config: PerchAuthConfig,
  accessToken: string
) {
  const response = yield* fetchExternalEffect(`${perchSupabaseUrl(config)}/rest/v1/rpc/perch_ai_select_plan`, {
    method: "POST",
    headers: { ...perchAuthHeaders(config), Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ p_plan_code: PERCH_STARTER_PLAN_CODE }),
    cache: "no-store",
  });
  const payload = yield* readJson<{ ok?: boolean; error?: string; reason?: string }>(response, {});
  if (!response.ok || payload.ok === false) {
    return yield* unavailable(
      payload.error === "banned"
        ? `Perch sign-in blocked: ${payload.reason ?? "account banned"}. Contact hello@perchai.app.`
        : "Could not select the Perch Starter plan. Pick a plan at https://chat.perchai.app/perchai."
    );
  }
});

const ensurePerchSessionReady = Effect.fn("perch.ensureSessionReady")(function* (accessToken: string) {
  const accountResponse = yield* fetchExternalEffect(`${PERCH_APP_URL}${PERCH_ACCOUNT_PATH}`, {
    method: "GET",
    headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!accountResponse.ok) return;
  const account = yield* readJson<PerchAccountResponse>(accountResponse, {});
  if (account.ok !== true || !account.session?.tierSelectionRequired) return;
  const config = yield* fetchPerchAuthConfig();
  yield* selectPerchStarterPlan(config, accessToken);
});

export const exchangePerchOAuthCode = Effect.fn("perch.exchangeOAuthCode")(function* (
  code: string,
  codeVerifier: string
) {
  const config = yield* fetchPerchAuthConfig();
  const response = yield* fetchExternalEffect(`${perchSupabaseUrl(config)}${PERCH_AUTH_TOKEN_PATH}?grant_type=pkce`, {
    method: "POST",
    headers: perchAuthHeaders(config),
    body: JSON.stringify({ auth_code: code, code_verifier: codeVerifier }),
    cache: "no-store",
  });
  if (!response.ok) {
    const body = yield* readText(response);
    return yield* unavailable(formatPerchError(response, body, "token exchange endpoint"));
  }
  const tokens = yield* readJson<PerchTokenResponse>(response, {});
  if (!tokens.access_token) {
    return yield* unavailable("Perch token exchange returned an incomplete session.");
  }
  yield* ensurePerchSessionReady(tokens.access_token);
  const expiresAt =
    typeof tokens.expires_at === "number" && tokens.expires_at > 0
      ? new Date(tokens.expires_at * 1000)
      : new Date(
          Date.now() +
            (typeof tokens.expires_in === "number" && tokens.expires_in > 0 ? tokens.expires_in : 3600) * 1000
        );
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? "",
    expiresAt,
    email: tokens.user?.email ?? "",
  } satisfies OAuthResult;
});
