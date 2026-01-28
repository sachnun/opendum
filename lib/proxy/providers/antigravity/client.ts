// Antigravity Provider Implementation

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
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_CLIENT_SECRET,
  ANTIGRAVITY_SCOPES,
  CODE_ASSIST_ENDPOINT,
  CODE_ASSIST_HEADERS,
  ANTIGRAVITY_MODELS,
  MODEL_ALIASES,
  ANTIGRAVITY_REFRESH_BUFFER_SECONDS,
} from "./constants";
import { generateRequestId } from "./request-helpers";
import { transformClaudeRequest, transformGeminiRequest } from "./transform";
import type { TransformContext } from "./transform/types";
import {
  convertOpenAIToGemini,
  convertGeminiToOpenAI,
  getModelFamily,
  createAntigravityUnwrapTransform,
  createGeminiToOpenAISseTransform,
} from "./converter";
import { cacheSignature } from "./cache";

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
  let model = MODEL_ALIASES[rawModel] ?? rawModel;
  
  // claude-opus-4-5 ALWAYS requires -thinking variant (non-thinking doesn't exist)
  if (model === "claude-opus-4-5") {
    model = "claude-opus-4-5-thinking";
  }
  
  return model;
}

export const antigravityConfig: ProviderConfig = {
  name: "antigravity",
  displayName: "Antigravity (Google)",
  supportedModels: ANTIGRAVITY_MODELS,
};

export const antigravityProvider: Provider = {
  config: antigravityConfig,

  getAuthUrl(state: string, codeVerifier?: string): string {
    if (!codeVerifier) {
      throw new Error("Code verifier required for Antigravity OAuth");
    }

    // Generate code challenge synchronously would require async
    // For now, we'll generate it and expect caller to await separately
    // Or use a simpler approach - store verifier and generate challenge inline
    const params = new URLSearchParams({
      client_id: ANTIGRAVITY_CLIENT_ID,
      redirect_uri: `${process.env.NEXTAUTH_URL || "http://localhost:3000"}/api/oauth/antigravity/callback`,
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
      throw new Error(`Token exchange failed: ${response.status} ${error}`);
    }

    const tokens = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    // Fetch account info (projectId, email)
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
      throw new Error(`Token refresh failed: ${response.status} ${error}`);
    }

    const tokens = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };

    // Fetch updated account info
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

    // Check if token needs refresh
    if (isTokenExpired(account.expiresAt)) {
      console.log(`Refreshing token for Antigravity account ${account.id}`);

      try {
        const newTokens = await this.refreshToken(refreshTokenValue);

        // Update database
        await prisma.providerAccount.update({
          where: { id: account.id },
          data: {
            accessToken: encrypt(newTokens.accessToken),
            refreshToken: encrypt(newTokens.refreshToken),
            expiresAt: newTokens.expiresAt,
            projectId: newTokens.projectId,
            tier: newTokens.tier,
            email: newTokens.email || account.email,
          },
        });

        accessToken = newTokens.accessToken;
        console.log(
          `Token refreshed successfully for Antigravity account ${account.id}`
        );
      } catch (error) {
        console.error(
          `Failed to refresh token for Antigravity account ${account.id}:`,
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
    const projectId = account.projectId;
    if (!projectId) {
      throw new Error("Antigravity account missing projectId");
    }

    const rawModel = body.model;
    const effectiveModel = resolveModelName(rawModel);
    const family = getModelFamily(effectiveModel);
    const sessionId = crypto.randomUUID();
    const requestId = generateRequestId();

    // Determine if reasoning output should be included in response
    // Only include if user explicitly requested reasoning
    const includeReasoning = body._includeReasoning ?? 
      !!(body.reasoning || body.reasoning_effort || body.thinking_budget || body.include_thoughts);

    const context: TransformContext = {
      model: effectiveModel,
      family,
      projectId,
      streaming: stream,
      requestId,
      sessionId,
    };

    // Convert OpenAI format to Gemini format
    const geminiPayload = convertOpenAIToGemini(body);

    // Transform for Antigravity (inject system prompts, wrap request, etc.)
    const isClaudeModel = effectiveModel.includes("claude");
    const result = isClaudeModel
      ? transformClaudeRequest(context, geminiPayload)
      : transformGeminiRequest(context, geminiPayload);

    // Claude models require streaming - force it and buffer if user wants non-streaming
    const needsForcedStreaming = isClaudeModel && !stream;
    const actualStream = needsForcedStreaming ? true : stream;

    // Build request URL
    const action = actualStream ? "streamGenerateContent?alt=sse" : "generateContent";
    const url = `${CODE_ASSIST_ENDPOINT}/v1internal:${action}`;

    // Build headers
    const headers = new Headers({
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: actualStream ? "text/event-stream" : "application/json",
      ...CODE_ASSIST_HEADERS,
    });

    // Add thinking header for Claude thinking models
    if (isClaudeModel && effectiveModel.includes("thinking")) {
      headers.set("anthropic-beta", "interleaved-thinking-2025-05-14");
    }

    // Make the request
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: result.body,
    });

    // If we forced streaming for Claude, buffer and convert to non-streaming
    if (needsForcedStreaming && response.ok && response.body) {
      const bufferedResponse = await bufferStreamingToGeminiResponse(response);

      // Cache signatures from buffered response
      cacheSignaturesFromResponse(
        bufferedResponse,
        family as "claude" | "gemini-flash" | "gemini-pro",
        sessionId
      );

      // Convert to OpenAI format and return as non-streaming
      const openaiResponse = convertGeminiToOpenAI(bufferedResponse, rawModel, includeReasoning);

      return new Response(JSON.stringify(openaiResponse), {
        status: response.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Transform response back to OpenAI format
    return await transformAntigravityResponse(
      response,
      stream,
      family,
      sessionId,
      rawModel,
      includeReasoning
    );
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
    // Stream: unwrap Antigravity wrapper, cache signatures, convert to OpenAI format
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
      parsed = (parsed.find((item) => typeof item === "object" && item !== null) ??
        {}) as Record<string, unknown>;
    }

    // Unwrap Antigravity wrapper
    const unwrapped = (parsed.response ?? parsed) as Record<string, unknown>;

    // Cache thought signatures
    cacheSignaturesFromResponse(
      unwrapped,
      family as "claude" | "gemini-flash" | "gemini-pro",
      sessionId
    );

    // Convert to OpenAI format (conditionally include reasoning)
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
 */
async function fetchAccountInfo(
  accessToken: string
): Promise<{ projectId: string; tier: string; email: string }> {
  const url = `${CODE_ASSIST_ENDPOINT}/v1internal:loadCodeAssist`;

  // Use specific headers for auth/discovery calls
  // User-Agent MUST be google-api-nodejs-client for proper tier detection
  const authHeaders = {
    "User-Agent": "google-api-nodejs-client/10.3.0",
    "X-Goog-Api-Client": "gl-node/22.18.0",
    "Client-Metadata": '{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}',
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...authHeaders,
    },
    body: JSON.stringify({
      metadata: {
        ideType: "IDE_UNSPECIFIED",
        platform: "PLATFORM_UNSPECIFIED",
        pluginType: "GEMINI",
      },
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to fetch account info: ${response.status} ${error}`);
  }

  const data = (await response.json()) as Record<string, unknown>;

  // Extract project ID - can be string or object with id
  let projectId = "";
  const cloudProject = data.cloudaicompanionProject;
  if (typeof cloudProject === "string" && cloudProject) {
    projectId = cloudProject;
  } else if (typeof cloudProject === "object" && cloudProject !== null) {
    const projectObj = cloudProject as Record<string, unknown>;
    projectId = (projectObj.id ?? "") as string;
  }

  // Extract tier from currentTier - can be string or object with id
  let tier = "free";
  const currentTier = data.currentTier;
  if (typeof currentTier === "string" && currentTier) {
    tier = currentTier;
  } else if (typeof currentTier === "object" && currentTier !== null) {
    const tierObj = currentTier as Record<string, unknown>;
    tier = (tierObj.id ?? tierObj.name ?? "free") as string;
  }

  // Also fetch user email from Google
  let email = "";
  try {
    const userInfoResponse = await fetch(
      "https://www.googleapis.com/oauth2/v2/userinfo",
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );
    if (userInfoResponse.ok) {
      const userInfo = (await userInfoResponse.json()) as { email?: string };
      email = userInfo.email ?? "";
    }
  } catch {
    // Ignore email fetch errors
  }

  return {
    projectId,
    tier,
    email,
  };
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

// Export utilities for OAuth flow
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

        // Handle array-wrapped responses
        if (Array.isArray(parsed)) {
          parsed = (parsed.find(
            (item) => typeof item === "object" && item !== null
          ) ?? {}) as Record<string, unknown>;
        }

        // Unwrap Antigravity wrapper
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

  // Collect all parts from all chunks
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

    // Capture finish reason from last chunk that has it
    if (candidate.finishReason) {
      finishReason = candidate.finishReason as string;
    }

    // Capture usage metadata (usually in last chunk)
    if (chunk.usageMetadata) {
      usageMetadata = chunk.usageMetadata as Record<string, unknown>;
    }
  }

  // Merge consecutive text parts
  const mergedParts: Array<Record<string, unknown>> = [];
  let currentText = "";
  let currentThought = "";
  let currentThoughtSignature: string | undefined;

  for (const part of allParts) {
    if (part.thought === true && typeof part.text === "string") {
      // Thinking block
      currentThought += part.text;
      if (part.thoughtSignature) {
        currentThoughtSignature = part.thoughtSignature as string;
      }
    } else if (typeof part.text === "string" && !part.functionCall) {
      // Regular text
      if (currentThought) {
        // Flush thinking block first
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
      // Tool call - flush any pending text first
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

  // Flush remaining text
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

  // Ensure at least one part
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
