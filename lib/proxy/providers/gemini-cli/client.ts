// Gemini CLI Provider Implementation
// Based on: https://github.com/Mirrowel/LLM-API-Key-Proxy/blob/main/src/rotator_library/providers/gemini_cli_provider.py

import type { ProviderAccount } from "@prisma/client";
import { encrypt, decrypt } from "@/lib/encryption";
import { prisma } from "@/lib/db";
import type {
  Provider,
  ProviderConfig,
  OAuthResult,
  ChatCompletionRequest,
} from "../types";
import {
  GEMINI_CLI_CLIENT_ID,
  GEMINI_CLI_CLIENT_SECRET,
  GEMINI_CLI_SCOPES,
  CODE_ASSIST_ENDPOINT,
  GEMINI_CLI_LOAD_CODE_ASSIST_ENDPOINTS,
  GEMINI_CLI_ONBOARD_USER_ENDPOINTS,
  GEMINI_CLI_MODELS,
  GEMINI_CLI_REFRESH_BUFFER_SECONDS,
  GEMINI_CLI_AUTH_HEADERS,
  buildGeminiCliUserAgent,
  THINKING_BUDGET_MAP,
  GEMINI3_THINKING_LEVELS,
  DEFAULT_SAFETY_SETTINGS,
} from "./constants";
import {
  convertOpenAIToGemini,
  convertGeminiToOpenAI,
  createGeminiToOpenAISseTransform,
  createAntigravityUnwrapTransform,
} from "../antigravity/converter";
import { cacheSignature } from "../antigravity/cache";

/**
 * Generate PKCE code verifier
 */
function generateCodeVerifier(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

/**
 * Generate PKCE code challenge from verifier
 */
async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const base64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Check if token needs refresh
 */
function isTokenExpired(expiresAt: Date): boolean {
  const bufferMs = GEMINI_CLI_REFRESH_BUFFER_SECONDS * 1000;
  return new Date().getTime() > expiresAt.getTime() - bufferMs;
}

/**
 * Check if model is Gemini 3 (requires special handling)
 */
function isGemini3Model(model: string): boolean {
  const modelName = model.split("/").pop()?.replace(":thinking", "") ?? model;
  return modelName.startsWith("gemini-3-");
}

/**
 * Generate unique prompt ID matching native gemini-cli format
 * Native JS: Math.random().toString(16).slice(2) produces 13-14 hex chars
 */
function generateUserPromptId(): string {
  const array = new Uint8Array(7);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Generate stable session ID based on first user message
 * This ensures same conversation = same session_id
 */
async function generateStableSessionId(
  contents: Array<Record<string, unknown>>
): Promise<string> {
  // Find first user message text
  for (const content of contents) {
    if (content.role === "user") {
      const parts = content.parts as Array<Record<string, unknown>> | undefined;
      if (parts) {
        for (const part of parts) {
          const text = part.text as string | undefined;
          if (text) {
            // SHA256 hash and format as UUID
            const encoder = new TextEncoder();
            const data = encoder.encode(text);
            const hashBuffer = await crypto.subtle.digest("SHA-256", data);
            const hashArray = new Uint8Array(hashBuffer);
            // Format as UUID (8-4-4-4-12 hex chars)
            const hex = Array.from(hashArray.slice(0, 16), (b) =>
              b.toString(16).padStart(2, "0")
            ).join("");
            return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
          }
        }
      }
    }
  }
  // Fallback to random UUID
  return crypto.randomUUID();
}

/**
 * Get thinking config based on model and reasoning_effort
 */
function getThinkingConfig(
  model: string,
  reasoningEffort?: string,
  thinkingBudget?: number
): Record<string, unknown> | undefined {
  const modelName = model.split("/").pop()?.replace(":thinking", "") ?? model;
  const isG3 = isGemini3Model(model);

  // If explicit budget provided, use it (only for Gemini 2.5)
  if (thinkingBudget !== undefined && !isG3) {
    return {
      thinkingBudget,
      includeThoughts: true,
    };
  }

  // No reasoning requested - don't send thinkingConfig at all
  // (thinkingBudget: 0 is not supported by some models like gemini-2.5-pro)
  if (!reasoningEffort || reasoningEffort === "none") {
    return undefined;
  }

  if (isG3) {
    // Gemini 3 uses thinkingLevel (low/medium/high for Flash, low/high for Pro)
    const levels = modelName.includes("flash")
      ? GEMINI3_THINKING_LEVELS["gemini-3-flash"]
      : GEMINI3_THINKING_LEVELS["gemini-3-pro"];

    const level = levels[reasoningEffort as keyof typeof levels] ?? levels.high;
    return {
      thinkingLevel: level,
      includeThoughts: true,
    };
  }

  // Gemini 2.5 uses thinkingBudget
  const budgets = modelName.includes("flash")
    ? THINKING_BUDGET_MAP["gemini-2.5-flash"]
    : modelName.includes("pro")
      ? THINKING_BUDGET_MAP["gemini-2.5-pro"]
      : THINKING_BUDGET_MAP.default;

  const budget = budgets[reasoningEffort as keyof typeof budgets] ?? budgets.high;
  return {
    thinkingBudget: budget,
    includeThoughts: true,
  };
}

export const geminiCliConfig: ProviderConfig = {
  name: "gemini_cli",
  displayName: "Gemini CLI",
  supportedModels: GEMINI_CLI_MODELS,
};

export const geminiCliProvider: Provider = {
  config: geminiCliConfig,

  getAuthUrl(state: string, codeVerifier?: string): string {
    if (!codeVerifier) {
      throw new Error("Code verifier required for Gemini CLI OAuth");
    }

    const params = new URLSearchParams({
      client_id: GEMINI_CLI_CLIENT_ID,
      redirect_uri: `${process.env.NEXTAUTH_URL || "http://localhost:3000"}/api/oauth/gemini-cli/callback`,
      response_type: "code",
      scope: GEMINI_CLI_SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
      state,
    });

    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  },

  async exchangeCode(
    code: string,
    redirectUri: string,
    codeVerifier?: string
  ): Promise<OAuthResult> {
    const body: Record<string, string> = {
      client_id: GEMINI_CLI_CLIENT_ID,
      client_secret: GEMINI_CLI_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    };

    if (codeVerifier) {
      body.code_verifier = codeVerifier;
    }

    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Token exchange failed: ${response.status} ${error}`);
    }

    const tokens = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    // Fetch account info (projectId, email, tier)
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
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: GEMINI_CLI_CLIENT_ID,
        client_secret: GEMINI_CLI_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Token refresh failed: ${response.status} ${error}`);
    }

    const tokens = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };

    // Fetch updated account info
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

  async getValidCredentials(account: ProviderAccount): Promise<string> {
    let accessToken = decrypt(account.accessToken);
    const refreshTokenValue = decrypt(account.refreshToken);

    // Check if token needs refresh
    if (isTokenExpired(account.expiresAt)) {
      console.log(`Refreshing token for Gemini CLI account ${account.id}`);

      try {
        const newTokens = await this.refreshToken(refreshTokenValue);

        // Update database
        await prisma.providerAccount.update({
          where: { id: account.id },
          data: {
            accessToken: encrypt(newTokens.accessToken),
            refreshToken: encrypt(newTokens.refreshToken),
            expiresAt: newTokens.expiresAt,
            projectId: newTokens.projectId || account.projectId,
            tier: newTokens.tier || account.tier,
            email: newTokens.email || account.email,
          },
        });

        accessToken = newTokens.accessToken;
        console.log(
          `Token refreshed successfully for Gemini CLI account ${account.id}`
        );
      } catch (error) {
        console.error(
          `Failed to refresh token for Gemini CLI account ${account.id}:`,
          error
        );
        // If refresh fails but token not truly expired, use existing
        if (new Date() < account.expiresAt) {
          console.log("Using existing token as fallback");
        } else {
          throw error;
        }
      }
    }

    return accessToken;
  },

  async makeRequest(
    accessToken: string,
    account: ProviderAccount,
    body: ChatCompletionRequest,
    stream: boolean
  ): Promise<Response> {
    let projectId = account.projectId;
    if (!projectId) {
      const accountInfo = await fetchGeminiCliAccountInfo(accessToken);
      if (!accountInfo.projectId) {
        throw new Error(
          accountInfo.error ??
            "Gemini CLI account missing projectId. Please re-authenticate or set GEMINI_CLI_PROJECT_ID."
        );
      }

      projectId = accountInfo.projectId;

      try {
        await prisma.providerAccount.update({
          where: { id: account.id },
          data: {
            projectId,
            tier: accountInfo.tier || account.tier,
            email: accountInfo.email || account.email,
          },
        });
      } catch {
      }
    }

    const model = body.model;
    const modelName = model.split("/").pop()?.replace(":thinking", "") ?? model;

    // Determine if reasoning output should be included in response
    const includeReasoning =
      body._includeReasoning ??
      !!(
        body.reasoning ||
        body.reasoning_effort ||
        body.thinking_budget ||
        body.include_thoughts
      );

    // Convert OpenAI format to Gemini format
    const geminiPayload = convertOpenAIToGemini(body);

    // Add thinking config if reasoning is requested
    const reasoningEffort = body.reasoning?.effort || body.reasoning_effort;
    const thinkingConfig = getThinkingConfig(
      model,
      reasoningEffort,
      body.thinking_budget
    );

    if (thinkingConfig) {
      if (!geminiPayload.generationConfig) {
        geminiPayload.generationConfig = {};
      }
      (geminiPayload.generationConfig as Record<string, unknown>).thinkingConfig =
        thinkingConfig;
    }

    // Add default safety settings to prevent content filtering
    (geminiPayload as Record<string, unknown>).safetySettings = DEFAULT_SAFETY_SETTINGS;

    // Generate stable session ID based on conversation content
    const contents = geminiPayload.contents as Array<Record<string, unknown>>;
    const sessionId = await generateStableSessionId(contents);

    // Generate unique prompt ID for this request (matches native gemini-cli)
    const userPromptId = generateUserPromptId();

    // Build payload matching native gemini-cli structure
    // Source: gemini-cli/packages/core/src/code_assist/converter.ts
    const requestPayload = {
      model: modelName,
      project: projectId,
      user_prompt_id: userPromptId,
      request: {
        ...geminiPayload,
        session_id: sessionId,
      },
    };

    // Build request URL
    const url = stream
      ? `${CODE_ASSIST_ENDPOINT}/v1internal:streamGenerateContent`
      : `${CODE_ASSIST_ENDPOINT}/v1internal:generateContent`;

    // Build headers with Gemini CLI specific User-Agent
    const headers = new Headers({
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: stream ? "text/event-stream" : "application/json",
      "User-Agent": buildGeminiCliUserAgent(model),
    });

    // Make the request
    const response = await fetch(
      stream ? `${url}?alt=sse` : url,
      {
        method: "POST",
        headers,
        body: JSON.stringify(requestPayload),
      }
    );

    // Transform response back to OpenAI format
    return await transformGeminiCliResponse(
      response,
      stream,
      sessionId,
      model,
      includeReasoning
    );
  },
};

/**
 * Transform Gemini CLI response to OpenAI format
 */
async function transformGeminiCliResponse(
  response: Response,
  streaming: boolean,
  sessionId: string,
  model: string,
  includeReasoning: boolean = true
): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? "";
  const isEventStream = contentType.includes("text/event-stream");

  if (streaming && response.ok && isEventStream && response.body) {
    // Stream: unwrap wrapper, cache signatures, convert to OpenAI format
    const transformedBody = response.body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(createAntigravityUnwrapTransform())
      .pipeThrough(createSignatureCachingTransform(sessionId))
      .pipeThrough(createGeminiToOpenAISseTransform(model, includeReasoning))
      .pipeThrough(new TextEncoderStream());

    return new Response(transformedBody, {
      status: response.status,
      statusText: response.statusText,
      headers: new Headers({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      }),
    });
  }

  // Non-streaming
  const text = await response.text();

  if (!response.ok) {
    return new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    let parsed = JSON.parse(text) as Record<string, unknown>;

    // Handle array-wrapped response
    if (Array.isArray(parsed)) {
      parsed = (parsed.find(
        (item) => typeof item === "object" && item !== null
      ) ?? {}) as Record<string, unknown>;
    }

    // Unwrap response wrapper
    const unwrapped = (parsed.response ?? parsed) as Record<string, unknown>;

    // Cache thought signatures
    cacheSignaturesFromResponse(unwrapped, sessionId);

    // Convert to OpenAI format
    const openaiResponse = convertGeminiToOpenAI(
      unwrapped,
      model,
      includeReasoning
    );

    return new Response(JSON.stringify(openaiResponse), {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    return new Response(text, {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  }
}

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

  for (const baseEndpoint of GEMINI_CLI_ONBOARD_USER_ENDPOINTS) {
    try {
      const response = await fetch(`${baseEndpoint}/v1internal:onboardUser`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          ...GEMINI_CLI_AUTH_HEADERS,
        },
        body: JSON.stringify(onboardRequest),
      });

      if (!response.ok) {
        continue;
      }

      let lroData = (await response.json()) as Record<string, unknown>;

      for (let i = 0; i < 30 && !lroData.done; i++) {
        await new Promise((resolve) => setTimeout(resolve, 2000));

        const pollResponse = await fetch(`${baseEndpoint}/v1internal:onboardUser`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            ...GEMINI_CLI_AUTH_HEADERS,
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
    const userInfoResponse = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (userInfoResponse.ok) {
      const userInfo = (await userInfoResponse.json()) as { email?: string };
      return userInfo.email ?? "";
    }
  } catch {
  }

  return "";
}

async function fetchGeminiCliProjectFromResourceManager(
  accessToken: string
): Promise<string> {
  try {
    const response = await fetch(
      "https://cloudresourcemanager.googleapis.com/v1/projects",
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          ...GEMINI_CLI_AUTH_HEADERS,
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
  const configuredProjectId = process.env.GEMINI_CLI_PROJECT_ID?.trim() || "";
  const requestMetadata = buildGeminiCliRequestMetadata(
    configuredProjectId || null
  );

  const errors: string[] = [];
  let projectId = "";
  let tier = "free-tier";
  let allowedTiers: GeminiCliAllowedTier[] = [];
  let discoveryError: string | undefined;

  for (const baseEndpoint of GEMINI_CLI_LOAD_CODE_ASSIST_ENDPOINTS) {
    try {
      const response = await fetch(`${baseEndpoint}/v1internal:loadCodeAssist`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          ...GEMINI_CLI_AUTH_HEADERS,
        },
        body: JSON.stringify({
          cloudaicompanionProject: configuredProjectId || null,
          metadata: requestMetadata,
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        errors.push(
          `${baseEndpoint}: HTTP ${response.status}${
            errorBody ? ` ${errorBody.slice(0, 250)}` : ""
          }`
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

/**
 * Cache signatures from response
 */
function cacheSignaturesFromResponse(
  response: Record<string, unknown>,
  sessionId: string
): void {
  const candidates = response.candidates as
    | Array<Record<string, unknown>>
    | undefined;
  if (!Array.isArray(candidates)) return;

  for (const candidate of candidates) {
    const content = candidate.content as Record<string, unknown> | undefined;
    if (!content) continue;

    const parts = content.parts as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(parts)) continue;

    for (const part of parts) {
      if (
        part.thought === true &&
        typeof part.text === "string" &&
        typeof part.thoughtSignature === "string"
      ) {
        // Use gemini-pro as family for Gemini CLI
        cacheSignature("gemini-pro", sessionId, part.text, part.thoughtSignature);
      }
    }
  }
}

/**
 * Create transform stream that caches thought signatures
 */
function createSignatureCachingTransform(
  sessionId: string
): TransformStream<string, string> {
  return new TransformStream<string, string>({
    transform(line, controller) {
      controller.enqueue(line);

      if (!line.startsWith("data:")) return;

      const json = line.slice(5).trim();
      if (!json) return;

      try {
        const parsed = JSON.parse(json) as Record<string, unknown>;
        cacheSignaturesFromResponse(parsed, sessionId);
      } catch {
        // Ignore parsing errors
      }
    },
  });
}

// Export utilities for OAuth flow
export { generateCodeVerifier, generateCodeChallenge };
