import type { ProviderAccount } from "../../../db/schema.js";
import { encrypt, decrypt } from "../../../encryption.js";
import { db } from "../../../db/index.js";
import { providerAccount } from "../../../db/schema.js";
import { eq } from "drizzle-orm";
import type {
  Provider,
  ProviderConfig,
  OAuthResult,
  ChatCompletionRequest,
} from "../types.js";
import { DEFAULT_PROVIDER_TIMEOUTS } from "../types.js";
import { fetchWithTimeout } from "../../timeout.js";
import { getAdaptiveTimeout } from "../../adaptive-timeout.js";
import {
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_CLIENT_SECRET,
  ANTIGRAVITY_SCOPES,
  CODE_ASSIST_ENDPOINT_FALLBACKS,
  CODE_ASSIST_HEADERS,
  ANTIGRAVITY_REFRESH_BUFFER_SECONDS,
  LOAD_CODE_ASSIST_ENDPOINTS,
  ONBOARD_USER_ENDPOINTS,
  ANTIGRAVITY_AUTH_HEADERS,
  DEFAULT_PROJECT_ID,
} from "./constants.js";
import { getUpstreamModelName, getProviderModelSet } from "../../models.js";
import { generateRequestId, isImageGenerationModel } from "./request-helpers.js";
import { transformClaudeRequest, transformGeminiRequest } from "./transform/index.js";
import type { TransformContext } from "./transform/types.js";
import {
  convertOpenAIToGemini,
  convertGeminiToOpenAI,
  getModelFamily,
  createAntigravityUnwrapTransform,
  createGeminiToOpenAISseTransform,
} from "./converter.js";
import { cacheSignature } from "./cache.js";
import { convertImageUrlsToBase64 } from "../../image-utils.js";

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
  const bufferMs = ANTIGRAVITY_REFRESH_BUFFER_SECONDS * 1000;
  return new Date().getTime() > expiresAt.getTime() - bufferMs;
}

/**
 * Resolve model name using aliases and apply model-specific rules
 */
function resolveModelName(rawModel: string): string {
  let model = getUpstreamModelName(rawModel, "antigravity");
  // Claude Opus models only exist as -thinking variants in Antigravity API
  if (model === "claude-opus-4-6") {
    model = "claude-opus-4-6-thinking";
  }
  
  return model;
}

function isOpusThinkingModel(model: string): boolean {
  return model.startsWith("claude-opus-") && model.endsWith("-thinking");
}

function normalizeRequestForModel(
  body: ChatCompletionRequest,
  effectiveModel: string
): ChatCompletionRequest {
  const normalizedBody: ChatCompletionRequest = { ...body };

  // Antigravity/Claude Opus thinking models reject top_p < 0.95.
  // Drop invalid values so upstream can apply its default safely.
  if (
    isOpusThinkingModel(effectiveModel) &&
    typeof normalizedBody.top_p === "number" &&
    normalizedBody.top_p < 0.95
  ) {
    delete normalizedBody.top_p;
  }

  // Image generation models (e.g. gemini-3-pro-image, gemini-3.1-flash-image)
  // do NOT support reasoning/thinking, tool calling, or presence/frequency penalties.
  // Strip these params to avoid upstream API errors.
  if (isImageGenerationModel(effectiveModel)) {
    delete normalizedBody.reasoning;
    delete normalizedBody.reasoning_effort;
    delete normalizedBody.thinking_budget;
    delete normalizedBody.include_thoughts;
    delete normalizedBody.presence_penalty;
    delete normalizedBody.frequency_penalty;
    delete normalizedBody.tools;
    delete normalizedBody.tool_choice;
    delete normalizedBody._includeReasoning;
  }

  return normalizedBody;
}

export const antigravityConfig: ProviderConfig = {
  name: "antigravity",
  displayName: "Antigravity (Google)",
  supportedModels: getProviderModelSet("antigravity"),
  timeouts: DEFAULT_PROVIDER_TIMEOUTS,
};

export const antigravityProvider: Provider = {
  config: antigravityConfig,

  getAuthUrl(state: string, codeVerifier?: string): string {
    if (!codeVerifier) {
      throw new Error("Code verifier required for Antigravity OAuth");
    }

    const params = new URLSearchParams({
      client_id: ANTIGRAVITY_CLIENT_ID,
      redirect_uri: `${process.env.BETTER_AUTH_URL || "http://localhost:3000"}/api/oauth/antigravity/callback`,
      response_type: "code",
      scope: ANTIGRAVITY_SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
      state,
    });

    // Note: Code challenge needs to be added by caller after async generation
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  },

  async exchangeCode(
    code: string,
    redirectUri: string,
    codeVerifier?: string
  ): Promise<OAuthResult> {
    const body: Record<string, string> = {
      client_id: ANTIGRAVITY_CLIENT_ID,
      client_secret: ANTIGRAVITY_CLIENT_SECRET,
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
      throw new Error(error);
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
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: ANTIGRAVITY_CLIENT_ID,
        client_secret: ANTIGRAVITY_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(error);
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

  async getValidCredentials(account: ProviderAccount): Promise<string> {
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
            projectId: newTokens.projectId,
            tier: newTokens.tier,
            email: newTokens.email || account.email,
          })
          .where(eq(providerAccount.id, account.id));

        accessToken = newTokens.accessToken;
      } catch (error) {
        // If refresh fails but token not truly expired, use existing
        if (new Date() < account.expiresAt) {
          return accessToken;
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
    const projectId = account.projectId || DEFAULT_PROJECT_ID;

    const rawModel = body.model;
    const effectiveModel = resolveModelName(rawModel);
    const normalizedBody = normalizeRequestForModel(body, effectiveModel);
    const family = getModelFamily(effectiveModel);
    const sessionId = crypto.randomUUID();
    const requestId = generateRequestId();

    const includeReasoning =
      (normalizedBody._includeReasoning ??
      !!(
        normalizedBody.reasoning ||
        normalizedBody.reasoning_effort ||
        normalizedBody.thinking_budget ||
        normalizedBody.include_thoughts
      )) ||
      isOpusThinkingModel(effectiveModel);

    const context: TransformContext = {
      model: effectiveModel,
      family,
      projectId,
      streaming: stream,
      requestId,
      sessionId,
    };

    const isClaudeModel = effectiveModel.includes("claude");

    // Claude rejects image URLs — convert HTTP(S) URLs to base64 data URIs
    if (isClaudeModel) {
      normalizedBody.messages = await convertImageUrlsToBase64(normalizedBody.messages);
    }

    const geminiPayload = convertOpenAIToGemini(normalizedBody);

    const result = isClaudeModel
      ? transformClaudeRequest(context, geminiPayload)
      : transformGeminiRequest(context, geminiPayload);

    // Non-native-Gemini models (Claude, GPT-OSS, etc.) require forced streaming
    // through Code Assist. Claude needs it because the API requires streaming;
    // OpenAI-compat models (e.g. gpt-oss-*) need it because Code Assist adds
    // stream_options internally which is rejected when stream is false.
    const isNativeGeminiModel = effectiveModel.includes("gemini");
    const needsForcedStreaming = !isNativeGeminiModel && !stream;
    const actualStream = needsForcedStreaming ? true : stream;

    const action = actualStream ? "streamGenerateContent?alt=sse" : "generateContent";

    const headers = new Headers({
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: actualStream ? "text/event-stream" : "application/json",
      ...CODE_ASSIST_HEADERS,
    });

    if (isClaudeModel && effectiveModel.includes("thinking")) {
      headers.set("anthropic-beta", "interleaved-thinking-2025-05-14");
    }

    let lastError: Error | null = null;
    for (const endpoint of CODE_ASSIST_ENDPOINT_FALLBACKS) {
      const url = `${endpoint}/v1internal:${action}`;

      try {
        const fallbackMs = actualStream
          ? antigravityConfig.timeouts.streamMs
          : antigravityConfig.timeouts.nonStreamMs;
        const timeoutMs = await getAdaptiveTimeout(
          antigravityConfig.name, body.model, actualStream, fallbackMs
        );
        const response = await fetchWithTimeout(url, {
          method: "POST",
          headers,
          body: result.body,
        }, timeoutMs);

        // 429 = quota exhausted (per-account, not per-endpoint).
        // Return immediately so the proxy rate-limit handler can parse
        // the quotaResetDelay and mark the account as rate-limited.
        if (response.status === 429) {
          const errorBody = await response.text();
          return new Response(errorBody, {
            status: 429,
            statusText: response.statusText,
            headers: { "Content-Type": "application/json" },
          });
        }

        // Check if error is retryable (account/server related) vs parameter error
        // Retryable: 5xx (server), 401 (auth), 403 (permission), 404 (endpoint)
        // Non-retryable: 400 (bad request), 409 (conflict), 422 (validation), other 4xx
        const isRetryableError =
          response.status >= 500 ||
          response.status === 401 ||
          response.status === 403 ||
          response.status === 404;

        if (!response.ok) {
          const errorBody = await response.text();

          if (isRetryableError) {
            lastError = new Error(errorBody);
            continue;
          }

          // Parameter/request error (400, 409, 422, etc.) - return immediately with original error
          return new Response(errorBody, {
            status: response.status,
            statusText: response.statusText,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (needsForcedStreaming && response.body) {
          const bufferedResponse = await bufferStreamingToGeminiResponse(response);

          cacheSignaturesFromResponse(
            bufferedResponse,
            family as "claude" | "gemini-flash" | "gemini-pro",
            sessionId
          );

          const openaiResponse = convertGeminiToOpenAI(bufferedResponse, rawModel, includeReasoning);

          return new Response(JSON.stringify(openaiResponse), {
            status: response.status,
            headers: { "Content-Type": "application/json" },
          });
        }

        return await transformAntigravityResponse(
          response,
          stream,
          family,
          sessionId,
          rawModel,
          includeReasoning
        );
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        continue;
      }
    }

    if (isImageGenerationModel(effectiveModel)) {
      const baseMsg = lastError?.message ?? "All Antigravity endpoints failed";
      const is404 = baseMsg.includes("404") || baseMsg.includes("NOT_FOUND") || baseMsg.includes("not found");
      if (is404) {
        throw new Error(
          `Model "${effectiveModel}" returned 404 (NOT_FOUND) from all Code Assist endpoints. ` +
          `This image generation model requires a paid Google account (Google AI Pro/Ultra or Gemini Code Assist subscription). ` +
          `Free-tier accounts do not have access to image generation models. ` +
          `Original error: ${baseMsg}`
        );
      }
    }
    throw lastError || new Error("All Antigravity endpoints failed");
  },
};

/**
 * Transform Antigravity response to OpenAI format
 * @param response - Raw response from Antigravity API
 * @param streaming - Whether this is a streaming response
 * @param family - Model family (claude, gemini-flash, gemini-pro)
 * @param sessionId - Session ID for signature caching
 * @param model - Model name for response
 * @param includeReasoning - Whether to include reasoning_content in response
 */
async function transformAntigravityResponse(
  response: Response,
  streaming: boolean,
  family: string,
  sessionId: string,
  model: string,
  includeReasoning: boolean = true
): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? "";
  const isEventStream = contentType.includes("text/event-stream");

  if (streaming && response.ok && isEventStream && response.body) {
    const transformedBody = response.body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(createAntigravityUnwrapTransform())
      .pipeThrough(
        createSignatureCachingTransform(family as "claude" | "gemini-flash" | "gemini-pro", sessionId)
      )
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

    if (Array.isArray(parsed)) {
      parsed = (parsed.find((item) => typeof item === "object" && item !== null) ??
        {}) as Record<string, unknown>;
    }

    const unwrapped = (parsed.response ?? parsed) as Record<string, unknown>;

    cacheSignaturesFromResponse(
      unwrapped,
      family as "claude" | "gemini-flash" | "gemini-pro",
      sessionId
    );

    const openaiResponse = convertGeminiToOpenAI(unwrapped, model, includeReasoning);

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
 * Fetch account info from Antigravity API
 * 
 * Discovery flow:
 * 1. Try loadCodeAssist with endpoint fallback (prod first for better resolution)
 * 2. Extract projectId and detect tier from response
 * 3. If no projectId and no currentTier, user needs onboarding
 * 4. Fetch user email from Google userinfo
 */
async function fetchAccountInfo(
  accessToken: string
): Promise<{ projectId: string; tier: string; email: string }> {
  const errors: string[] = [];
  
  let detectedTier = "free";
  let projectId = "";
  let currentTier: Record<string, unknown> | null = null;
  let allowedTiers: Array<Record<string, unknown>> = [];

  const requestMetadata = {
    ideType: "IDE_UNSPECIFIED",
    platform: "PLATFORM_UNSPECIFIED",
    pluginType: "GEMINI",
  };

  for (const baseEndpoint of LOAD_CODE_ASSIST_ENDPOINTS) {
    try {
      const response = await fetch(`${baseEndpoint}/v1internal:loadCodeAssist`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          ...ANTIGRAVITY_AUTH_HEADERS,
        },
        body: JSON.stringify({
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

      if (Array.isArray(data.allowedTiers)) {
        const defaultTier = (data.allowedTiers as Array<Record<string, unknown>>).find(
          (t) => t.isDefault
        );
        if (defaultTier && typeof defaultTier.id === "string") {
          const tierId = defaultTier.id;
          // "legacy-tier" is the default free tier. Anything else is likely paid/upgraded.
          if (tierId !== "legacy-tier" && !tierId.includes("free") && !tierId.includes("zero")) {
            detectedTier = "paid";
          }
        }
      }

      // Check paidTier field (e.g. Google One AI Pro) which overrides default project tier
      const paidTier = data.paidTier as Record<string, unknown> | undefined;
      if (paidTier && typeof paidTier.id === "string") {
        const paidTierId = paidTier.id;
        if (!paidTierId.includes("free") && !paidTierId.includes("zero")) {
          detectedTier = "paid";
        }
      }

      if (projectId) {
        break;
      }

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
    const userInfoResponse = await fetch(
      "https://www.googleapis.com/oauth2/v2/userinfo",
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...ANTIGRAVITY_AUTH_HEADERS,
        },
      }
    );
    if (userInfoResponse.ok) {
      const userInfo = (await userInfoResponse.json()) as { email?: string };
      email = userInfo.email ?? "";
    }
  } catch {
    // Ignore email fetch errors
  }

  if (errors.length && !projectId) {
    projectId = DEFAULT_PROJECT_ID;
  }

  return {
    projectId,
    tier: detectedTier,
    email,
  };
}

/**
 * Extract projectId from API response
 * Handles both string and object formats:
 * - String: "project-id-123"
 * - Object: {"id": "project-id-123", ...}
 */
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

/**
 * Onboard new user to Antigravity
 * 
 * For new users who don't have a currentTier, we need to onboard them
 * to get a projectId assigned by the server.
 */
async function onboardUser(
  accessToken: string,
  allowedTiers: Array<Record<string, unknown>>,
  requestMetadata: Record<string, string>
): Promise<{ projectId: string; tier: string } | null> {
  let onboardTier = allowedTiers.find((t) => t.isDefault);
  
  if (!onboardTier && allowedTiers.length > 0) {
    onboardTier = allowedTiers.find((t) => t.id === "legacy-tier") ?? allowedTiers[0];
  }

  if (!onboardTier) {
    return null;
  }

  const tierId = (onboardTier.id as string) ?? "free-tier";

  // Build onboard request (do NOT add cloudaicompanionProject - auto-provisioned by Google)
  const onboardRequest = {
    tierId,
    metadata: requestMetadata,
  };

  for (const baseEndpoint of ONBOARD_USER_ENDPOINTS) {
    try {
      const response = await fetch(`${baseEndpoint}/v1internal:onboardUser`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          ...ANTIGRAVITY_AUTH_HEADERS,
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
            ...ANTIGRAVITY_AUTH_HEADERS,
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
      const projectId = extractProjectId(lroResponse);

      if (projectId) {
        const tier = tierId.includes("free") || tierId.includes("legacy") ? "free" : "paid";
        return { projectId, tier };
      }
    } catch {
    }
  }

  return null;
}

/**
 * Cache signatures from response
 */
function cacheSignaturesFromResponse(
  response: Record<string, unknown>,
  family: "claude" | "gemini-flash" | "gemini-pro",
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
        cacheSignature(family, sessionId, part.text, part.thoughtSignature);
      }
    }
  }
}

/**
 * Create transform stream that caches thought signatures
 */
function createSignatureCachingTransform(
  family: "claude" | "gemini-flash" | "gemini-pro",
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
        cacheSignaturesFromResponse(parsed, family, sessionId);
      } catch {
        // Ignore parsing errors
      }
    },
  });
}

export { generateCodeVerifier, generateCodeChallenge };

/**
 * Buffer streaming response and merge into single Gemini response object.
 * Used when Claude models require streaming but user requested non-streaming.
 */
async function bufferStreamingToGeminiResponse(
  response: Response
): Promise<Record<string, unknown>> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();

  let buffer = "";
  const chunks: Record<string, unknown>[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const json = line.slice(5).trim();
      if (!json || json === "[DONE]") continue;

      try {
        let parsed = JSON.parse(json) as Record<string, unknown>;

        if (Array.isArray(parsed)) {
          parsed = (parsed.find(
            (item) => typeof item === "object" && item !== null
          ) ?? {}) as Record<string, unknown>;
        }

        const unwrapped = (parsed.response ?? parsed) as Record<string, unknown>;
        if (unwrapped.candidates) {
          chunks.push(unwrapped);
        }
      } catch {
        /* ignore parse errors */
      }
    }
  }

  return mergeGeminiChunks(chunks);
}

/**
 * Merge array of Gemini streaming chunks into single response.
 * Concatenates text, collects tool calls, preserves thinking blocks.
 */
function mergeGeminiChunks(
  chunks: Record<string, unknown>[]
): Record<string, unknown> {
  if (chunks.length === 0) {
    return {
      candidates: [
        {
          content: { role: "model", parts: [{ text: "" }] },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
    };
  }

  const allParts: Array<Record<string, unknown>> = [];
  let finishReason = "STOP";
  let usageMetadata: Record<string, unknown> = {};

  for (const chunk of chunks) {
    const candidates = chunk.candidates as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(candidates) || candidates.length === 0) continue;

    const candidate = candidates[0];
    const content = candidate.content as Record<string, unknown> | undefined;
    const parts = content?.parts as Array<Record<string, unknown>> | undefined;

    if (Array.isArray(parts)) {
      allParts.push(...parts);
    }

    if (candidate.finishReason) {
      finishReason = candidate.finishReason as string;
    }

    if (chunk.usageMetadata) {
      usageMetadata = chunk.usageMetadata as Record<string, unknown>;
    }
  }

  const mergedParts: Array<Record<string, unknown>> = [];
  let currentText = "";
  let currentThought = "";
  let currentThoughtSignature: string | undefined;

  for (const part of allParts) {
    if (part.thought === true && typeof part.text === "string") {
      currentThought += part.text;
      if (part.thoughtSignature) {
        currentThoughtSignature = part.thoughtSignature as string;
      }
    } else if (typeof part.text === "string" && !part.functionCall) {
      if (currentThought) {
        mergedParts.push({
          thought: true,
          text: currentThought,
          ...(currentThoughtSignature && { thoughtSignature: currentThoughtSignature }),
        });
        currentThought = "";
        currentThoughtSignature = undefined;
      }
      currentText += part.text;
    } else if (part.functionCall) {
      if (currentThought) {
        mergedParts.push({
          thought: true,
          text: currentThought,
          ...(currentThoughtSignature && { thoughtSignature: currentThoughtSignature }),
        });
        currentThought = "";
        currentThoughtSignature = undefined;
      }
      if (currentText) {
        mergedParts.push({ text: currentText });
        currentText = "";
      }
      mergedParts.push(part);
    }
  }

  if (currentThought) {
    mergedParts.push({
      thought: true,
      text: currentThought,
      ...(currentThoughtSignature && { thoughtSignature: currentThoughtSignature }),
    });
  }
  if (currentText) {
    mergedParts.push({ text: currentText });
  }

  if (mergedParts.length === 0) {
    mergedParts.push({ text: "" });
  }

  return {
    candidates: [
      {
        content: { role: "model", parts: mergedParts },
        finishReason,
      },
    ],
    usageMetadata,
  };
}
