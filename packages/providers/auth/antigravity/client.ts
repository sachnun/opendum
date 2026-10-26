import { Effect } from "effect";

import { OAuthClient } from "@opendum/providers/auth/client";
import type { AuthRuntime } from "@opendum/providers/auth/runtime";
import type { OAuthResult } from "@opendum/providers/auth/result";
import { ProviderResponse } from "@opendum/providers/auth/response";
import { validToken, type CredentialAccount } from "@opendum/providers/auth/credentials";
import {
  AUTH_HEADERS,
  CLIENT_ID,
  CLIENT_SECRET,
  DEFAULT_PROJECT_ID,
  LOAD_ENDPOINTS,
  ONBOARD_USER_ENDPOINTS,
  REFRESH_BUFFER_SECONDS,
} from "@opendum/providers/auth/antigravity/constants";

const TOKEN_URL = "https://oauth2.googleapis.com/token";

const FORM_HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded",
  Accept: "application/json",
};

type GoogleToken = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
};

function pickToken(payload: unknown): GoogleToken | null {
  const value = payload as Partial<GoogleToken> | null;
  if (!value || typeof value.access_token !== "string" || !value.access_token) return null;
  return value as GoogleToken;
}

class AntigravityClient extends OAuthClient {
  constructor(runtime: AuthRuntime) {
    super({ provider: "antigravity", label: "Antigravity" }, runtime);
  }
}

export function antigravityAuth(runtime: AuthRuntime) {
  const response = new ProviderResponse("Antigravity");
  const client = new AntigravityClient(runtime);

  function normalizeTier(value: unknown): string {
    return typeof value === "string" ? value.trim().toLowerCase() : "";
  }

  function isPaid(value: string): boolean {
    const normalized = normalizeTier(value);
    if (!normalized || normalized === "free-tier") return false;
    return normalized === "paid" || normalized === "standard-tier" || normalized.startsWith("g1-");
  }

  type AccountCredentials = CredentialAccount & { email: string };

  const exchangeAntigravityCode = Effect.fn("antigravity.exchangeCode")(function* (
    code: string,
    redirectUri: string,
    codeVerifier?: string
  ) {
    const body: Record<string, string> = {
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    };

    if (codeVerifier) {
      body.code_verifier = codeVerifier;
    }

    const tokens = yield* client.decode<GoogleToken>(
      {
        url: TOKEN_URL,
        endpoint: "token exchange endpoint",
        init: { method: "POST", headers: FORM_HEADERS, body: new URLSearchParams(body) },
      },
      pickToken
    );
    const accountInfo = yield* fetchAccountInfo(tokens.access_token);

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
      email: accountInfo.email,
      projectId: accountInfo.projectId,
      tier: accountInfo.tier,
    } satisfies OAuthResult;
  });

  const refreshAntigravityToken = Effect.fn("antigravity.refreshToken")(function* (refreshToken: string) {
    const tokens = yield* client.decode<GoogleToken>(
      {
        url: TOKEN_URL,
        endpoint: "token refresh endpoint",
        init: {
          method: "POST",
          headers: FORM_HEADERS,
          body: new URLSearchParams({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            refresh_token: refreshToken,
            grant_type: "refresh_token",
          }),
        },
      },
      pickToken
    );
    const accountInfo = yield* fetchAccountInfo(tokens.access_token);

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? refreshToken,
      expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
      email: accountInfo.email,
      projectId: accountInfo.projectId,
      tier: accountInfo.tier,
    } satisfies OAuthResult;
  });

  const validCredentials = Effect.fn("antigravity.getValidCredentials")(function* (
    account: AccountCredentials
  ) {
    return yield* validToken(account, {
      bufferSeconds: REFRESH_BUFFER_SECONDS,
      message: "Failed to persist refreshed Antigravity credentials",
      refresh: refreshAntigravityToken,
      patch: (refreshed) => ({
        projectId: refreshed.projectId,
        tier: refreshed.tier,
        email: refreshed.email || account.email,
      }),
      tolerateFailure: true,
    }, runtime.store);
  });

  const antigravityProvider = {
    exchangeCode: exchangeAntigravityCode,
    refreshToken: refreshAntigravityToken,
    getValidCredentials: validCredentials,
  };

  const fetchAccountInfo = Effect.fn("antigravity.fetchAccountInfo")(function* (accessToken: string) {
    const errors: string[] = [];
    const requestMetadata = {
      ideType: "IDE_UNSPECIFIED",
      platform: "PLATFORM_UNSPECIFIED",
      pluginType: "GEMINI",
    };

    let detectedTier = "free-tier";
    let projectId = "";
    let currentTier: Record<string, unknown> | null = null;
    let allowedTiers: Array<Record<string, unknown>> = [];

    for (const baseEndpoint of LOAD_ENDPOINTS) {
      const loaded = yield* Effect.gen(function* () {
        const attempt = yield* runtime.fetch(`${baseEndpoint}/v1internal:loadCodeAssist`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            ...AUTH_HEADERS,
          },
          body: JSON.stringify({
            cloudaicompanionProject: null,
            metadata: requestMetadata,
          }),
        });

        if (!attempt.ok) {
          const errorText = yield* response.text(attempt);
          return { ok: false as const, message: `loadCodeAssist at ${baseEndpoint}: ${attempt.status} ${errorText}` };
        }

        const data = yield* response.json<Record<string, unknown>>(attempt);
        return { ok: true as const, data };
      }).pipe(Effect.catch((error) => Effect.succeed({ ok: false as const, message: `loadCodeAssist at ${baseEndpoint}: ${error.message}` })));

      if (!loaded.ok) {
        errors.push(loaded.message);
        continue;
      }

      const data = loaded.data;
      projectId = projectFrom(data);
      currentTier = (data.currentTier as Record<string, unknown>) ?? null;
      allowedTiers = (data.allowedTiers as Array<Record<string, unknown>>) ?? [];

      const currentTierId = tierId(currentTier);
      if (currentTierId) {
        detectedTier = currentTierId;
      }

      const defaultTier = allowedTiers.find((tier) => tier.isDefault);
      const defaultTierId = tierId(defaultTier ?? null);
      if (!currentTierId && defaultTierId) {
        detectedTier = defaultTierId;
      }

      const paidInfo = data.paidTier as Record<string, unknown> | undefined;
      const paidTierId = tierId(paidInfo ?? null);
      if (paidTierId && isPaid(paidTierId)) {
        detectedTier = paidTierId;
      }

      if (projectId) break;
      errors.push(`loadCodeAssist at ${baseEndpoint}: no projectId in response`);
    }

    if (!projectId && !currentTier) {
      const onboardResult = yield* onboardUser(accessToken, allowedTiers, requestMetadata);
      if (onboardResult) {
        projectId = onboardResult.projectId;
        if (onboardResult.tier) {
          detectedTier = onboardResult.tier;
        }
      }
    }

    const email = yield* Effect.gen(function* () {
      const userInfoResponse = yield* runtime.fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...AUTH_HEADERS,
        },
      });
      if (!userInfoResponse.ok) return "";
      const userInfo = yield* response.json<{ email?: string }>(userInfoResponse);
      return userInfo.email ?? "";
    }).pipe(Effect.catch(() => Effect.succeed("")));

    if (errors.length && !projectId) {
      projectId = DEFAULT_PROJECT_ID;
    }

    return { projectId, tier: detectedTier, email };
  });

  function projectFrom(data: Record<string, unknown>): string {
    const cloudProject = data.cloudaicompanionProject;

    if (typeof cloudProject === "string" && cloudProject) {
      return cloudProject;
    }

    if (typeof cloudProject === "object" && cloudProject !== null) {
      const projectObj = cloudProject as Record<string, unknown>;
      const id = projectObj.id;
      if (typeof id === "string" && id) {
        return id;
      }
    }

    return "";
  }

  function tierId(tier: Record<string, unknown> | null): string {
    if (!tier) return "";
    return normalizeTier(tier.id) || normalizeTier(tier.name);
  }

  const onboardUser = Effect.fn("antigravity.onboardUser")(function* (
    accessToken: string,
    allowedTiers: Array<Record<string, unknown>>,
    requestMetadata: Record<string, string>
  ) {
    let onboardTier = allowedTiers.find((tier) => tier.isDefault);

    if (!onboardTier && allowedTiers.length > 0) {
      onboardTier = allowedTiers.find((tier) => tier.id === "legacy-tier") ?? allowedTiers[0];
    }

    if (!onboardTier) {
      return null;
    }

    const tierId = (onboardTier.id as string) ?? "free-tier";
    const onboardRequest = {
      tierId,
      cloudaicompanionProject: null,
      metadata: requestMetadata,
    };

    for (const baseEndpoint of ONBOARD_USER_ENDPOINTS) {
      const onboarded = yield* Effect.gen(function* () {
        const created = yield* runtime.fetch(`${baseEndpoint}/v1internal:onboardUser`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            ...AUTH_HEADERS,
          },
          body: JSON.stringify(onboardRequest),
        });

        if (!created.ok) return null;

        let lroData = yield* response.json<Record<string, unknown>>(created);

        for (let i = 0; i < 30 && !lroData.done; i++) {
          yield* Effect.sleep("2 seconds");

          const pollResponse = yield* runtime.fetch(`${baseEndpoint}/v1internal:onboardUser`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
              ...AUTH_HEADERS,
            },
            body: JSON.stringify(onboardRequest),
          });

          if (pollResponse.ok) {
            lroData = yield* response.json<Record<string, unknown>>(pollResponse);
          }
        }

        if (!lroData.done) return null;

        const lroResponse = (lroData.response ?? lroData) as Record<string, unknown>;
        const projectId = projectFrom(lroResponse);
        if (!projectId) return null;
        return { projectId, tier: normalizeTier(tierId) || "free-tier" };
      }).pipe(Effect.catch(() => Effect.succeed(null)));

      if (onboarded) return onboarded;
    }

    return null;
  });

  return { antigravityProvider };
}
