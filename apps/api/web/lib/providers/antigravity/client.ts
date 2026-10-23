import { eq } from "drizzle-orm";

import { db, providerAccount, type ProviderAccount } from "@opendum/database";
import { decrypt, encrypt } from "#web/lib/encryption.js";
import { Effect } from "effect";
import { fetchExternalEffect } from "#web/lib/external.js";
import { fromPromise } from "#web/lib/task.js";
import { unavailable } from "#web/errors.js";
import type { OAuthResult } from "../types.js";
import { formatProviderHttpError } from "../provider-http-errors.js";
import {
  AUTH_HEADERS,
  CLIENT_ID,
  CLIENT_SECRET,
  DEFAULT_PROJECT_ID,
  LOAD_CODE_ASSIST_ENDPOINTS,
  ONBOARD_USER_ENDPOINTS,
  REFRESH_BUFFER_SECONDS,
} from "./constants.js";

function isTokenExpired(expiresAt: Date): boolean {
  const bufferMs = REFRESH_BUFFER_SECONDS * 1000;
  return Date.now() > expiresAt.getTime() - bufferMs;
}

function normalizeAntigravityTierId(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isPaidAntigravityTierId(value: string): boolean {
  const normalized = normalizeAntigravityTierId(value);
  if (!normalized || normalized === "free-tier") return false;
  return normalized === "paid" || normalized === "standard-tier" || normalized.startsWith("g1-");
}

type CredentialAccount = Pick<ProviderAccount, "id" | "accessToken" | "refreshToken" | "expiresAt" | "email">;

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

  const response = yield* fetchExternalEffect("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });

  if (!response.ok) {
    const error = yield* readText(response);
    return yield* unavailable(
      formatProviderHttpError("Antigravity", response, error, {
        endpointLabel: "token exchange endpoint",
      })
    );
  }

  const tokens = yield* readJson<{ access_token: string; refresh_token: string; expires_in: number }>(
    response
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
  const response = yield* fetchExternalEffect("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) {
    const error = yield* readText(response);
    return yield* unavailable(
      formatProviderHttpError("Antigravity", response, error, {
        endpointLabel: "token refresh endpoint",
      })
    );
  }

  const tokens = yield* readJson<{ access_token: string; refresh_token?: string; expires_in: number }>(
    response
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

const getValidAntigravityCredentials = Effect.fn("antigravity.getValidCredentials")(function* (
  account: CredentialAccount
) {
  const accessToken = decrypt(account.accessToken);
  if (!isTokenExpired(account.expiresAt)) return accessToken;

  const refreshed = yield* refreshAntigravityToken(decrypt(account.refreshToken)).pipe(
    Effect.catch((error) =>
      new Date() < account.expiresAt ? Effect.succeed(null) : Effect.fail(error)
    )
  );
  if (!refreshed) return accessToken;

  yield* fromPromise(
    () =>
      db
        .update(providerAccount)
        .set({
          accessToken: encrypt(refreshed.accessToken),
          refreshToken: encrypt(refreshed.refreshToken!),
          expiresAt: refreshed.expiresAt,
          projectId: refreshed.projectId,
          tier: refreshed.tier,
          email: refreshed.email || account.email,
        })
        .where(eq(providerAccount.id, account.id)),
    "Failed to persist refreshed Antigravity credentials"
  );

  return refreshed.accessToken;
});

export const antigravityProvider = {
  exchangeCode: exchangeAntigravityCode,
  refreshToken: refreshAntigravityToken,
  getValidCredentials: getValidAntigravityCredentials,
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

  for (const baseEndpoint of LOAD_CODE_ASSIST_ENDPOINTS) {
    const loaded = yield* Effect.gen(function* () {
      const response = yield* fetchExternalEffect(`${baseEndpoint}/v1internal:loadCodeAssist`, {
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

      if (!response.ok) {
        const errorText = yield* readText(response);
        return { ok: false as const, message: `loadCodeAssist at ${baseEndpoint}: ${response.status} ${errorText}` };
      }

      const data = yield* readJson<Record<string, unknown>>(response);
      return { ok: true as const, data };
    }).pipe(Effect.catch((error) => Effect.succeed({ ok: false as const, message: `loadCodeAssist at ${baseEndpoint}: ${error.message}` })));

    if (!loaded.ok) {
      errors.push(loaded.message);
      continue;
    }

    const data = loaded.data;
    projectId = extractProjectId(data);
    currentTier = (data.currentTier as Record<string, unknown>) ?? null;
    allowedTiers = (data.allowedTiers as Array<Record<string, unknown>>) ?? [];

    const currentTierId = extractTierId(currentTier);
    if (currentTierId) {
      detectedTier = currentTierId;
    }

    const defaultTier = allowedTiers.find((tier) => tier.isDefault);
    const defaultTierId = extractTierId(defaultTier ?? null);
    if (!currentTierId && defaultTierId) {
      detectedTier = defaultTierId;
    }

    const paidTier = data.paidTier as Record<string, unknown> | undefined;
    const paidTierId = extractTierId(paidTier ?? null);
    if (paidTierId && isPaidAntigravityTierId(paidTierId)) {
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
    const userInfoResponse = yield* fetchExternalEffect("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...AUTH_HEADERS,
      },
    });
    if (!userInfoResponse.ok) return "";
    const userInfo = yield* readJson<{ email?: string }>(userInfoResponse);
    return userInfo.email ?? "";
  }).pipe(Effect.catch(() => Effect.succeed("")));

  if (errors.length && !projectId) {
    projectId = DEFAULT_PROJECT_ID;
  }

  return { projectId, tier: detectedTier, email };
});

function extractProjectId(data: Record<string, unknown>): string {
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

function extractTierId(tier: Record<string, unknown> | null): string {
  if (!tier) return "";
  return normalizeAntigravityTierId(tier.id) || normalizeAntigravityTierId(tier.name);
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
      const response = yield* fetchExternalEffect(`${baseEndpoint}/v1internal:onboardUser`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          ...AUTH_HEADERS,
        },
        body: JSON.stringify(onboardRequest),
      });

      if (!response.ok) return null;

      let lroData = yield* readJson<Record<string, unknown>>(response);

      for (let i = 0; i < 30 && !lroData.done; i++) {
        yield* Effect.sleep("2 seconds");

        const pollResponse = yield* fetchExternalEffect(`${baseEndpoint}/v1internal:onboardUser`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            ...AUTH_HEADERS,
          },
          body: JSON.stringify(onboardRequest),
        });

        if (pollResponse.ok) {
          lroData = yield* readJson<Record<string, unknown>>(pollResponse);
        }
      }

      if (!lroData.done) return null;

      const lroResponse = (lroData.response ?? lroData) as Record<string, unknown>;
      const projectId = extractProjectId(lroResponse);
      if (!projectId) return null;
      return { projectId, tier: normalizeAntigravityTierId(tierId) || "free-tier" };
    }).pipe(Effect.catch(() => Effect.succeed(null)));

    if (onboarded) return onboarded;
  }

  return null;
});

function readText(response: Response) {
  return fromPromise(() => response.text(), "Failed to read Antigravity response");
}

function readJson<T>(response: Response) {
  return fromPromise(async () => ((await response.json()) as T), "Failed to read Antigravity response");
}
