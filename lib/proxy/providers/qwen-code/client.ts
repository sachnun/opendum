// Qwen Code Provider Implementation
// Uses Device Code Flow for OAuth (similar to TV/device authentication)

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
  QWEN_CODE_CLIENT_ID,
  QWEN_CODE_SCOPE,
  QWEN_CODE_TOKEN_ENDPOINT,
  QWEN_CODE_DEVICE_CODE_ENDPOINT,
  QWEN_CODE_API_BASE_URL,
  QWEN_CODE_SUPPORTED_PARAMS,
  QWEN_CODE_MODELS,
  QWEN_CODE_REFRESH_BUFFER_SECONDS,
} from "./constants";

/**
 * Device code response from Qwen API
 */
export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

/**
 * Token response from Qwen API
 */
interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  resource_url?: string;
}

/**
 * Generate PKCE code verifier
 */
function generateCodeVerifier(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  // Base64url encode
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
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
 * Check if token needs refresh (with buffer)
 */
function isTokenExpired(expiresAt: Date): boolean {
  const bufferMs = QWEN_CODE_REFRESH_BUFFER_SECONDS * 1000;
  return new Date().getTime() > expiresAt.getTime() - bufferMs;
}

/**
 * Clean tool schemas to prevent API errors
 */
function cleanToolSchemas(
  tools: Array<{ type: string; function: Record<string, unknown> }>
): Array<{ type: string; function: Record<string, unknown> }> {
  return tools.map((tool) => {
    const cleaned = { ...tool };

    if (cleaned.function) {
      // Remove unsupported properties
      delete cleaned.function.strict;

      if (cleaned.function.parameters) {
        delete (cleaned.function.parameters as Record<string, unknown>)
          .additionalProperties;

        // Recursively clean nested properties
        if (
          (cleaned.function.parameters as Record<string, unknown>).properties
        ) {
          cleanSchemaProperties(
            (cleaned.function.parameters as Record<string, unknown>)
              .properties as Record<string, unknown>
          );
        }
      }
    }

    return cleaned;
  });
}

function cleanSchemaProperties(properties: Record<string, unknown>): void {
  for (const key of Object.keys(properties)) {
    const prop = properties[key] as Record<string, unknown>;
    delete prop.additionalProperties;
    delete prop.strict;

    if (prop.properties) {
      cleanSchemaProperties(prop.properties as Record<string, unknown>);
    }

    if ((prop.items as Record<string, unknown>)?.properties) {
      cleanSchemaProperties(
        (prop.items as Record<string, unknown>).properties as Record<
          string,
          unknown
        >
      );
    }
  }
}

/**
 * Build request payload with only supported parameters
 */
function buildRequestPayload(
  params: Record<string, unknown>,
  forceStream?: boolean
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(params)) {
    if (QWEN_CODE_SUPPORTED_PARAMS.has(key) && value !== undefined) {
      payload[key] = value;
    }
  }

  // Use stream value from params, or force if specified
  if (forceStream !== undefined) {
    payload.stream = forceStream;
  } else if (payload.stream === undefined) {
    payload.stream = true; // Default to streaming
  }

  // Always include usage data in stream
  if (payload.stream === true) {
    payload.stream_options = { include_usage: true };
  }

  // Clean tool schemas if present
  if (payload.tools && Array.isArray(payload.tools)) {
    if (payload.tools.length > 0) {
      payload.tools = cleanToolSchemas(
        payload.tools as Array<{ type: string; function: Record<string, unknown> }>
      );
    } else if (payload.stream === true) {
      // Per Qwen Code API bug, injecting a dummy tool prevents stream corruption
      // when no tools are provided
      payload.tools = [
        {
          type: "function",
          function: {
            name: "do_not_call_me",
            description: "Do not call this tool.",
            parameters: { type: "object", properties: {} },
          },
        },
      ];
    }
  }

  return payload;
}

export const qwenCodeConfig: ProviderConfig = {
  name: "qwen_code",
  displayName: "Qwen Code",
  supportedModels: QWEN_CODE_MODELS,
};

export const qwenCodeProvider: Provider = {
  config: qwenCodeConfig,

  /**
   * For Device Code Flow, we don't use a traditional auth URL.
   * Instead, we initiate device code flow and return the verification URL.
   * This method is kept for interface compatibility but shouldn't be called directly.
   */
  getAuthUrl(_state: string, _codeVerifier?: string): string {
    // Device code flow doesn't use a redirect-based auth URL
    // The actual URL is obtained from initiateDeviceCodeFlow()
    throw new Error(
      "Qwen Code uses Device Code Flow. Use initiateDeviceCodeFlow() instead."
    );
  },

  /**
   * Exchange device code for tokens (called after user completes auth)
   * For Qwen Code, this is called with the device_code as the "code" parameter
   */
  async exchangeCode(
    code: string,
    _redirectUri: string,
    codeVerifier?: string
  ): Promise<OAuthResult> {
    const body: Record<string, string> = {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: code,
      client_id: QWEN_CODE_CLIENT_ID,
    };

    if (codeVerifier) {
      body.code_verifier = codeVerifier;
    }

    const response = await fetch(QWEN_CODE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      body: new URLSearchParams(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Token exchange failed: ${response.status} ${error}`);
    }

    const tokens: TokenResponse = await response.json();

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
      email: "", // Email will be set from user input during device flow
    };
  },

  async refreshToken(refreshToken: string): Promise<OAuthResult> {
    const response = await fetch(QWEN_CODE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: QWEN_CODE_CLIENT_ID,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Token refresh failed: ${response.status} ${error}`);
    }

    const tokens: TokenResponse = await response.json();

    return {
      accessToken: tokens.access_token,
      // Qwen uses rotating refresh tokens - new token replaces old one
      refreshToken: tokens.refresh_token ?? refreshToken,
      expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
      email: "", // Preserve from existing account
    };
  },

  async getValidCredentials(account: ProviderAccount): Promise<string> {
    let accessToken = decrypt(account.accessToken);
    const refreshTokenValue = decrypt(account.refreshToken);

    // Check if token needs refresh
    if (isTokenExpired(account.expiresAt)) {
      console.log(`Refreshing token for Qwen Code account ${account.id}`);

      try {
        const newTokens = await this.refreshToken(refreshTokenValue);

        // Update database IMMEDIATELY (rotating token concern)
        // Qwen uses rotating refresh tokens - must save new token before it's invalidated
        await prisma.providerAccount.update({
          where: { id: account.id },
          data: {
            accessToken: encrypt(newTokens.accessToken),
            refreshToken: encrypt(newTokens.refreshToken),
            expiresAt: newTokens.expiresAt,
          },
        });

        accessToken = newTokens.accessToken;
        console.log(
          `Token refreshed successfully for Qwen Code account ${account.id}`
        );
      } catch (error) {
        console.error(
          `Failed to refresh token for Qwen Code account ${account.id}:`,
          error
        );
        // If refresh fails but token not truly expired, try using existing
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
    _account: ProviderAccount,
    body: ChatCompletionRequest,
    stream: boolean
  ): Promise<Response> {
    // Strip provider prefix from model name
    const modelName = body.model.includes("/")
      ? body.model.split("/").pop()!
      : body.model;

    const requestPayload = buildRequestPayload(
      {
        ...body,
        model: modelName,
      },
      stream
    );

    const response = await fetch(`${QWEN_CODE_API_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: stream ? "text/event-stream" : "application/json",
        "User-Agent": "google-api-nodejs-client/9.15.1",
        "X-Goog-Api-Client": "gl-node/22.17.0",
        "Client-Metadata":
          "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI",
      },
      body: JSON.stringify(requestPayload),
    });

    // For streaming responses, transform to handle <think> tags
    if (stream && response.ok && response.body) {
      const transformedBody = response.body
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(createThinkTagTransform(modelName))
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

    return response;
  },
};

/**
 * Initiate Device Code Flow
 * Returns device code info including URL for user to visit
 */
export async function initiateDeviceCodeFlow(): Promise<{
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  verificationUrlComplete: string;
  expiresIn: number;
  interval: number;
  codeVerifier: string;
}> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  const response = await fetch(QWEN_CODE_DEVICE_CODE_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
    body: new URLSearchParams({
      client_id: QWEN_CODE_CLIENT_ID,
      scope: QWEN_CODE_SCOPE,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Device code request failed: ${response.status} ${error}`);
  }

  const data: DeviceCodeResponse = await response.json();

  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUrl: data.verification_uri,
    verificationUrlComplete: data.verification_uri_complete,
    expiresIn: data.expires_in,
    interval: data.interval,
    codeVerifier,
  };
}

/**
 * Poll for device code authorization
 * Returns tokens when user completes auth, or null if still pending
 */
export async function pollDeviceCodeAuthorization(
  deviceCode: string,
  codeVerifier: string
): Promise<OAuthResult | { pending: true } | { error: string }> {
  const response = await fetch(QWEN_CODE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
      client_id: QWEN_CODE_CLIENT_ID,
      code_verifier: codeVerifier,
    }),
  });

  if (response.status === 200) {
    const tokens: TokenResponse = await response.json();
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
      email: "",
    };
  }

  if (response.status === 400) {
    const errorData = await response.json();
    const errorType = errorData.error;

    if (errorType === "authorization_pending") {
      return { pending: true };
    }

    if (errorType === "slow_down") {
      return { pending: true };
    }

    if (errorType === "expired_token") {
      return { error: "Device code expired. Please start again." };
    }

    if (errorType === "access_denied") {
      return { error: "Authorization was denied by the user." };
    }

    return { error: errorData.error_description || errorType };
  }

  const error = await response.text();
  return { error: `Unexpected error: ${response.status} ${error}` };
}

/**
 * Create transform stream to handle <think> tags in Qwen responses
 * Converts <think>...</think> to reasoning_content field
 */
function createThinkTagTransform(_model: string): TransformStream<string, string> {
  let buffer = "";
  let inThinkingBlock = false;

  return new TransformStream<string, string>({
    transform(chunk, controller) {
      buffer += chunk;

      // Process complete lines
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.startsWith("data: ")) {
          controller.enqueue(line + "\n");
          continue;
        }

        const jsonStr = line.slice(6).trim();
        if (jsonStr === "[DONE]") {
          controller.enqueue(line + "\n");
          continue;
        }

        try {
          const parsed = JSON.parse(jsonStr);
          const choices = parsed.choices || [];

          for (const choice of choices) {
            const delta = choice.delta || {};
            const content = delta.content;

            if (typeof content === "string") {
              // Handle <think> tags
              let processedContent = content;
              let reasoningContent: string | undefined;

              if (content.includes("<think>")) {
                inThinkingBlock = true;
                const parts = content.split("<think>");
                processedContent = parts[0];
                if (parts[1]) {
                  reasoningContent = parts[1];
                }
              }

              if (inThinkingBlock && content.includes("</think>")) {
                inThinkingBlock = false;
                const parts = content.split("</think>");
                if (!reasoningContent) {
                  reasoningContent = parts[0];
                } else {
                  reasoningContent += parts[0];
                }
                processedContent = parts[1] || "";
              }

              if (inThinkingBlock && !content.includes("<think>")) {
                reasoningContent = content;
                processedContent = "";
              }

              // Update delta
              if (reasoningContent) {
                delta.reasoning_content = reasoningContent;
              }
              if (processedContent !== content) {
                delta.content = processedContent || null;
              }
            }
          }

          // Re-serialize and output
          const output = `data: ${JSON.stringify(parsed)}\n`;
          controller.enqueue(output);
        } catch {
          // Pass through unparseable lines
          controller.enqueue(line + "\n");
        }
      }
    },
    flush(controller) {
      if (buffer) {
        controller.enqueue(buffer);
      }
    },
  });
}

// Export utilities
export { generateCodeVerifier, generateCodeChallenge };
