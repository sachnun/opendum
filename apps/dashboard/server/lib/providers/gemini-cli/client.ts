// Based on: https://github.com/Mirrowel/LLM-API-Key-Proxy/blob/main/src/rotator_library/providers/gemini_cli_provider.py

import type { ProviderAccount } from "../../db/schema.js";
import { encrypt, decrypt } from "../../encryption.js";
import { db } from "../../db/index.js";
import { providerAccount } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { fetchInternalProvider } from "../../proxy/internal-relay.js";
import type { OAuthResult } from "../types.js";
import {
  CLIENT_ID,
  CLIENT_SECRET,
  LOAD_CODE_ASSIST_ENDPOINTS,
  ONBOARD_USER_ENDPOINTS,
  REFRESH_BUFFER_SECONDS,
  AUTH_HEADERS,
} from "./constants.js";
import { formatProviderHttpError } from "../provider-http-errors.js";

/**
 * Check if token needs refresh
 */
function isTokenExpired(expiresAt: Date): boolean {
  const bufferMs = REFRESH_BUFFER_SECONDS * 1000;
  return new Date().getTime() > expiresAt.getTime() - bufferMs;
}

type CredentialAccount = Pick<ProviderAccount, "id" | "accessToken" | "refreshToken" | "expiresAt" | "projectId" | "tier" | "email">;

export const geminiCliProvider = {

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
      throw new Error(formatProviderHttpError("Gemini CLI", response, error, { endpointLabel: "token exchange endpoint" }));
    }

    const tokens = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    const accountInfo = await fetchGeminiCliAccountInfo(tokens.access_token);

    if (!accountInfo.projectId) {
      throw new Error(
        accountInfo.error ??
          "Gemini CLI account missing projectId. Set GEMINI_CLI_PROJECT_ID or retry authentication."
      );
    }

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
      throw new Error(formatProviderHttpError("Gemini CLI", response, error, { endpointLabel: "token refresh endpoint" }));
    }

    const tokens = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };

    const accountInfo = await fetchGeminiCliAccountInfo(tokens.access_token);

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
        const newTokens = await this.refreshToken(refreshTokenValue);

        await db
          .update(providerAccount)
          .set({
            accessToken: encrypt(newTokens.accessToken),
            refreshToken: encrypt(newTokens.refreshToken),
            expiresAt: newTokens.expiresAt,
            projectId: newTokens.projectId || account.projectId,
            tier: newTokens.tier || account.tier,
            email: newTokens.email || account.email,
          })
          .where(eq(providerAccount.id, account.id));

        accessToken = newTokens.accessToken;
      } catch (error) {
        console.error(
          `Failed to refresh token for Gemini CLI account ${account.id}:`,
          error
        );
        if (new Date() >= account.expiresAt) throw error;
      }
    }

    return accessToken;
  },

};

/**
 * Fetch account info from Gemini CLI / Code Assist API
 */
export interface GeminiCliAccountInfo {
  projectId: string;
  tier: string;
  email: string;
  error?: string;
}

interface GeminiCliAllowedTier {
  id: string;
  isDefault: boolean;
  requiresUserProject: boolean;
}

interface GeminiCliOnboardResult {
  projectId: string;
  tier: string;
  error?: string;
}

function buildGeminiCliRequestMetadata(
  configuredProjectId: string | null
): Record<string, string> {
  const metadata: Record<string, string> = {
    ideType: "IDE_UNSPECIFIED",
    platform: "PLATFORM_UNSPECIFIED",
    pluginType: "GEMINI",
  };

  if (configuredProjectId) {
    metadata.duetProject = configuredProjectId;
  }

  return metadata;
}

function extractGeminiCliProjectId(data: Record<string, unknown>): string {
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

function extractGeminiCliCurrentTierId(
  data: Record<string, unknown>
): string | null {
  const currentTier = data.currentTier;

  if (typeof currentTier === "string" && currentTier) {
    return currentTier;
  }

  if (typeof currentTier === "object" && currentTier !== null) {
    const tierObj = currentTier as Record<string, unknown>;
    const id = tierObj.id;
    if (typeof id === "string" && id) {
      return id;
    }

    const name = tierObj.name;
    if (typeof name === "string" && name) {
      return name;
    }
  }

  return null;
}

function extractGeminiCliAllowedTiers(
  data: Record<string, unknown>
): GeminiCliAllowedTier[] {
  const allowed = data.allowedTiers;
  if (!Array.isArray(allowed)) {
    return [];
  }

  const result: GeminiCliAllowedTier[] = [];

  for (const entry of allowed) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }

    const tier = entry as Record<string, unknown>;
    const id = tier.id;
    if (typeof id !== "string" || !id) {
      continue;
    }

    result.push({
      id,
      isDefault: tier.isDefault === true,
      requiresUserProject: tier.userDefinedCloudaicompanionProject === true,
    });
  }

  return result;
}

async function onboardGeminiCliUser(
  accessToken: string,
  allowedTiers: GeminiCliAllowedTier[],
  configuredProjectId: string | null
): Promise<GeminiCliOnboardResult | null> {
  let onboardTier = allowedTiers.find((tier) => tier.isDefault);

  if (!onboardTier && allowedTiers.length > 0) {
    onboardTier =
      allowedTiers.find((tier) => tier.id === "legacy-tier") ?? allowedTiers[0];
  }

  if (!onboardTier) {
    return null;
  }

  const tierId = onboardTier.id || "free-tier";
  const isFreeTier = tierId === "free-tier";

  if (!isFreeTier && onboardTier.requiresUserProject && !configuredProjectId) {
    return {
      projectId: "",
      tier: tierId,
      error: `Gemini tier '${tierId}' requires GEMINI_CLI_PROJECT_ID.`,
    };
  }

  const requestMetadata = buildGeminiCliRequestMetadata(configuredProjectId);

  const onboardRequest = {
    tierId,
    cloudaicompanionProject: isFreeTier ? null : configuredProjectId,
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

      if (!response.ok) {
        continue;
      }

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

      if (!lroData.done) {
        continue;
      }

      const lroResponse = (lroData.response ?? lroData) as Record<string, unknown>;
      const projectId =
        extractGeminiCliProjectId(lroResponse) || configuredProjectId || "";
      if (!projectId) {
        continue;
      }

      return {
        projectId,
        tier: tierId,
      };
    } catch {
      continue;
    }
  }

  return {
    projectId: "",
    tier: tierId,
    error: `Gemini onboarding failed to produce projectId for tier '${tierId}'.`,
  };
}

async function fetchGeminiCliEmail(accessToken: string): Promise<string> {
  try {
    const userInfoResponse = await fetchInternalProvider("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (userInfoResponse.ok) {
      const userInfo = (await userInfoResponse.json()) as { email?: string };
      return userInfo.email ?? "";
    }
  } catch {
    return "";
  }

  return "";
}

async function fetchGeminiCliProjectFromResourceManager(
  accessToken: string
): Promise<string> {
  try {
    const response = await fetchInternalProvider(
      "https://cloudresourcemanager.googleapis.com/v1/projects",
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          ...AUTH_HEADERS,
        },
        cache: "no-store",
      }
    );

    if (!response.ok) {
      return "";
    }

    const payload = (await response.json()) as {
      projects?: Array<{ projectId?: string; lifecycleState?: string }>;
    };

    const activeProject = (payload.projects ?? []).find(
      (project) =>
        project.lifecycleState === "ACTIVE" &&
        typeof project.projectId === "string" &&
        project.projectId.length > 0
    );

    return activeProject?.projectId ?? "";
  } catch {
    return "";
  }
}

export async function fetchGeminiCliAccountInfo(
  accessToken: string
): Promise<GeminiCliAccountInfo> {
  const configuredProjectId = "";
  const requestMetadata = buildGeminiCliRequestMetadata(
    configuredProjectId || null
  );

  const errors: string[] = [];
  let projectId = "";
  let tier = "free-tier";
  let allowedTiers: GeminiCliAllowedTier[] = [];
  let discoveryError: string | undefined;

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
          cloudaicompanionProject: configuredProjectId || null,
          metadata: requestMetadata,
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        errors.push(
          `${baseEndpoint}: ${formatProviderHttpError("Gemini CLI", response, errorBody, { endpointLabel: "account info endpoint", bodyLimit: 250 })}`
        );
        continue;
      }

      const data = (await response.json()) as Record<string, unknown>;
      const currentTierId = extractGeminiCliCurrentTierId(data);
      if (currentTierId) {
        tier = currentTierId;
      }

      const discoveredAllowedTiers = extractGeminiCliAllowedTiers(data);
      if (discoveredAllowedTiers.length > 0) {
        allowedTiers = discoveredAllowedTiers;
        if (!currentTierId) {
          const defaultTier =
            discoveredAllowedTiers.find((item) => item.isDefault) ??
            discoveredAllowedTiers[0];
          if (defaultTier?.id) {
            tier = defaultTier.id;
          }
        }
      }

      projectId = extractGeminiCliProjectId(data);
      if (!projectId && configuredProjectId) {
        projectId = configuredProjectId;
      }

      if (!projectId && currentTierId) {
        const matchedTier = allowedTiers.find((item) => item.id === currentTierId);
        if (matchedTier?.requiresUserProject && !configuredProjectId) {
          discoveryError =
            `Gemini tier '${currentTierId}' requires GEMINI_CLI_PROJECT_ID to resolve projectId.`;
        }
      }

      if (projectId) {
        break;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${baseEndpoint}: ${message}`);
    }
  }

  if (!projectId && allowedTiers.length > 0) {
    const onboardResult = await onboardGeminiCliUser(
      accessToken,
      allowedTiers,
      configuredProjectId || null
    );
    if (onboardResult) {
      projectId = onboardResult.projectId;
      tier = onboardResult.tier;
      if (!projectId && onboardResult.error) {
        discoveryError = onboardResult.error;
      }
    }
  }

  if (!projectId && configuredProjectId) {
    projectId = configuredProjectId;
  }

  if (!projectId) {
    const discoveredFromResourceManager =
      await fetchGeminiCliProjectFromResourceManager(accessToken);
    if (discoveredFromResourceManager) {
      projectId = discoveredFromResourceManager;
    }
  }

  if (!projectId && !discoveryError && errors.length > 0) {
    discoveryError = `Gemini CLI project discovery failed: ${errors.join("; ")}`;
  }

  if (!projectId && errors.length > 0) {
    console.warn(`Gemini CLI project discovery failed: ${errors.join("; ")}`);
  }

  const email = await fetchGeminiCliEmail(accessToken);

  return {
    projectId,
    tier,
    email,
    error: discoveryError,
  };
}
