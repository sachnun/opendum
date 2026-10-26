import { Effect } from "effect";

import { OAuthClient } from "@opendum/providers/auth/client";
import type { AuthRuntime } from "@opendum/providers/auth/runtime";
import { ProviderResponse } from "@opendum/providers/auth/response";
import { Pkce } from "@opendum/providers/auth/pkce";
import type { OAuthResult } from "@opendum/providers/auth/result";
import {
  PERCH_ACCOUNT_PATH,
  PERCH_APP_URL,
  PERCH_CONFIG_PATH,
  PERCH_TOKEN_PATH,
  PERCH_REDIRECT_URI,
  PERCH_PLAN_CODE,
} from "@opendum/providers/auth/perch/constants";

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

export interface PerchInitiateResult {
    authUrl: string;
    codeVerifier: string;
    verificationUrl: string;
}

class PerchClient extends OAuthClient {
  constructor(runtime: AuthRuntime) {
    super({ provider: "perch", label: "Perch" }, runtime);
  }
}

export function perchAuth(runtime: AuthRuntime) {
  const response = new ProviderResponse("Perch");
  const client = new PerchClient(runtime);

  const authConfig = Effect.fn("perch.authConfig")(function* () {
    const config = yield* client.decode<Partial<PerchAuthConfig>>(
      {
        url: `${PERCH_APP_URL}${PERCH_CONFIG_PATH}`,
        endpoint: "auth config endpoint",
        init: { method: "GET", headers: { Accept: "application/json" }, cache: "no-store" },
      },
      (payload) => (payload as Partial<PerchAuthConfig> | null) ?? null
    );
    if (!config.supabaseUrl || !config.supabaseAnonKey) {
      return yield* Effect.fail(client.fail("Perch auth config is incomplete. Please try again later."));
    }
    return config as PerchAuthConfig;
  });

  function providerId(config: PerchAuthConfig) {
    const enabled = (config.providers ?? []).filter((provider) => provider === "google" || provider === "github");
    if (enabled.length === 0) {
      return Effect.fail(runtime.unavailable("No supported Perch OAuth provider is enabled right now."));
    }
    return Effect.succeed(enabled.includes("google") ? "google" : "github");
  }

  const pkcePair = Effect.fn("perch.pkcePair")(function* () {
    return yield* Pkce.pair("Perch");
  });

  function supabaseUrl(config: PerchAuthConfig): string {
    return config.supabaseUrl.replace(/\/+$/, "");
  }

  function authHeaders(config: PerchAuthConfig): Record<string, string> {
    return {
      "Content-Type": "application/json",
      apikey: config.supabaseAnonKey,
      Authorization: `Bearer ${config.supabaseAnonKey}`,
      Accept: "application/json",
    };
  }


  const initiateOAuth = Effect.fn("perch.initiateOAuth")(function* () {
    const config = yield* authConfig();
    const { verifier, challenge } = yield* pkcePair();
    const provider = yield* providerId(config);
    const params = new URLSearchParams({
      provider,
      code_challenge: challenge,
      code_challenge_method: "s256",
      redirect_to: PERCH_REDIRECT_URI,
    });
    const authUrl = `${supabaseUrl(config)}/auth/v1/authorize?${params.toString()}`;
    return { authUrl, codeVerifier: verifier, verificationUrl: authUrl } satisfies PerchInitiateResult;
  });

  const selectPlan = Effect.fn("perch.selectStarterPlan")(function* (
    config: PerchAuthConfig,
    accessToken: string
  ) {
    const result = yield* runtime.fetch(`${supabaseUrl(config)}/rest/v1/rpc/perch_ai_select_plan`, {
      method: "POST",
      headers: { ...authHeaders(config), Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ p_plan_code: PERCH_PLAN_CODE }),
      cache: "no-store",
    });
    const payload = yield* response.jsonOr<{ ok?: boolean; error?: string; reason?: string }>(result, {});
    if (!result.ok || payload.ok === false) {
      return yield* runtime.unavailable(
        payload.error === "banned"
          ? `Perch sign-in blocked: ${payload.reason ?? "account banned"}. Contact hello@perchai.app.`
          : "Could not select the Perch Starter plan. Pick a plan at https://chat.perchai.app/perchai."
      );
    }
  });

  const ensureSession = Effect.fn("perch.ensureSessionReady")(function* (accessToken: string) {
    const accountResponse = yield* runtime.fetch(`${PERCH_APP_URL}${PERCH_ACCOUNT_PATH}`, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });
    if (!accountResponse.ok) return;
    const account = yield* response.jsonOr<PerchAccountResponse>(accountResponse, {});
    if (account.ok !== true || !account.session?.tierSelectionRequired) return;
    const config = yield* authConfig();
    yield* selectPlan(config, accessToken);
  });

  const exchangeCode = Effect.fn("perch.exchangeOAuthCode")(function* (
    code: string,
    codeVerifier: string
  ) {
    const config = yield* authConfig();
    const result = yield* runtime.fetch(`${supabaseUrl(config)}${PERCH_TOKEN_PATH}?grant_type=pkce`, {
      method: "POST",
      headers: authHeaders(config),
      body: JSON.stringify({ auth_code: code, code_verifier: codeVerifier }),
      cache: "no-store",
    });
    if (!result.ok) {
      const body = yield* response.text(result);
      return yield* runtime.unavailable(response.failure(result, body, "token exchange endpoint"));
    }
    const tokens = yield* response.jsonOr<PerchTokenResponse>(result, {});
    if (!tokens.access_token) {
      return yield* runtime.unavailable("Perch token exchange returned an incomplete session.");
    }
    yield* ensureSession(tokens.access_token);
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

  return { initiateOAuth, exchangeCode };
}
