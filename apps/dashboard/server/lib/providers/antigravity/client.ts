import { eq } from "drizzle-orm";

import { db } from "../../db/index.js";
import { providerAccount, type ProviderAccount } from "../../db/schema.js";
import { decrypt, encrypt } from "../../encryption.js";
import { fetchInternalProvider } from "../../proxy/internal-relay.js";
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

type CredentialAccount = Pick<ProviderAccount, "id" | "accessToken" | "refreshToken" | "expiresAt" | "email">;

export const antigravityProvider = {
  async exchangeCode(
    code: string,
    redirectUri: string,
    codeVerifier?: string
  ): Promise<OAuthResult> {
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

    const response = await fetchInternalProvider("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(
        formatProviderHttpError("Antigravity", response, error, {
          endpointLabel: "token exchange endpoint",
        })
      );
    }

    const tokens = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    const accountInfo = await fetchAccountInfo(tokens.access_token);

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
      email: accountInfo.email,
      projectId: accountInfo.projectId,
      tier: accountInfo.tier,
    };
  },

  async refreshToken(refreshToken: string): Promise<OAuthResult> {
    const response = await fetchInternalProvider("https://oauth2.googleapis.com/token", {
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
      const error = await response.text();
      throw new Error(
        formatProviderHttpError("Antigravity", response, error, {
          endpointLabel: "token refresh endpoint",
        })
      );
    }

    const tokens = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };

    const accountInfo = await fetchAccountInfo(tokens.access_token);

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? refreshToken,
      expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
      email: accountInfo.email,
      projectId: accountInfo.projectId,
      tier: accountInfo.tier,
    };
  },

  async getValidCredentials(account: CredentialAccount): Promise<string> {
    let accessToken = decrypt(account.accessToken);
    const refreshTokenValue = decrypt(account.refreshToken);

    if (isTokenExpired(account.expiresAt)) {
      try {
        const newTokens = await antigravityProvider.refreshToken(refreshTokenValue);

        await db
          .update(providerAccount)
          .set({
            accessToken: encrypt(newTokens.accessToken),
            refreshToken: encrypt(newTokens.refreshToken),
            expiresAt: newTokens.expiresAt,
            projectId: newTokens.projectId,
            tier: newTokens.tier,
            email: newTokens.email || account.email,
          })
          .where(eq(providerAccount.id, account.id));

        accessToken = newTokens.accessToken;
      } catch (error) {
        if (new Date() < account.expiresAt) return accessToken;
        throw error;
      }
    }

    return accessToken;
  },
};

async function fetchAccountInfo(
  accessToken: string
): Promise<{ projectId: string; tier: string; email: string }> {
  const errors: string[] = [];
  const requestMetadata = {
    ideType: "IDE_UNSPECIFIED",
    platform: "PLATFORM_UNSPECIFIED",
    pluginType: "GEMINI",
  };

  let detectedTier = "free";
  let projectId = "";
  let currentTier: Record<string, unknown> | null = null;
  let allowedTiers: Array<Record<string, unknown>> = [];

  for (const baseEndpoint of LOAD_CODE_ASSIST_ENDPOINTS) {
    try {
      const response = await fetchInternalProvider(`${baseEndpoint}/v1internal:loadCodeAssist`, {
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
        const errorText = await response.text();
        errors.push(`loadCodeAssist at ${baseEndpoint}: ${response.status} ${errorText}`);
        continue;
      }

      const data = (await response.json()) as Record<string, unknown>;
      projectId = extractProjectId(data);
      currentTier = (data.currentTier as Record<string, unknown>) ?? null;
      allowedTiers = (data.allowedTiers as Array<Record<string, unknown>>) ?? [];

      const defaultTier = allowedTiers.find((tier) => tier.isDefault);
      if (defaultTier && typeof defaultTier.id === "string") {
        const tierId = defaultTier.id;
        if (tierId !== "legacy-tier" && !tierId.includes("free") && !tierId.includes("zero")) {
          detectedTier = "paid";
        }
      }

      const paidTier = data.paidTier as Record<string, unknown> | undefined;
      if (paidTier && typeof paidTier.id === "string") {
        const paidTierId = paidTier.id;
        if (!paidTierId.includes("free") && !paidTierId.includes("zero")) {
          detectedTier = "paid";
        }
      }

      if (projectId) break;
      errors.push(`loadCodeAssist at ${baseEndpoint}: no projectId in response`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      errors.push(`loadCodeAssist at ${baseEndpoint}: ${errorMsg}`);
    }
  }

  if (!projectId && !currentTier) {
    const onboardResult = await onboardUser(accessToken, allowedTiers, requestMetadata);
    if (onboardResult) {
      projectId = onboardResult.projectId;
      if (onboardResult.tier) {
        detectedTier = onboardResult.tier;
      }
    }
  }

  let email = "";
  try {
    const userInfoResponse = await fetchInternalProvider(
      "https://www.googleapis.com/oauth2/v2/userinfo",
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...AUTH_HEADERS,
        },
      }
    );
    if (userInfoResponse.ok) {
      const userInfo = (await userInfoResponse.json()) as { email?: string };
      email = userInfo.email ?? "";
    }
  } catch {
    // Email is best-effort metadata for dashboard display.
  }

  if (errors.length && !projectId) {
    projectId = DEFAULT_PROJECT_ID;
  }

  return { projectId, tier: detectedTier, email };
}

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

async function onboardUser(
  accessToken: string,
  allowedTiers: Array<Record<string, unknown>>,
  requestMetadata: Record<string, string>
): Promise<{ projectId: string; tier: string } | null> {
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
    try {
      const response = await fetchInternalProvider(`${baseEndpoint}/v1internal:onboardUser`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          ...AUTH_HEADERS,
        },
        body: JSON.stringify(onboardRequest),
      });

      if (!response.ok) continue;

      let lroData = (await response.json()) as Record<string, unknown>;

      for (let i = 0; i < 30 && !lroData.done; i++) {
        await new Promise((resolve) => setTimeout(resolve, 2000));

        const pollResponse = await fetchInternalProvider(`${baseEndpoint}/v1internal:onboardUser`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            ...AUTH_HEADERS,
          },
          body: JSON.stringify(onboardRequest),
        });

        if (pollResponse.ok) {
          lroData = (await pollResponse.json()) as Record<string, unknown>;
        }
      }

      if (!lroData.done) continue;

      const lroResponse = (lroData.response ?? lroData) as Record<string, unknown>;
      const projectId = extractProjectId(lroResponse);
      if (projectId) {
        const tier = tierId.includes("free") || tierId.includes("legacy") ? "free" : "paid";
        return { projectId, tier };
      }
    } catch {
      continue;
    }
  }

  return null;
}
