// iFlow Provider Implementation

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
  IFLOW_OAUTH_AUTHORIZE_URL,
  IFLOW_OAUTH_TOKEN_URL,
  IFLOW_USER_INFO_URL,
  IFLOW_API_BASE_URL,
  IFLOW_CLIENT_ID,
  IFLOW_CLIENT_SECRET,
  IFLOW_REDIRECT_URI,
  IFLOW_SUPPORTED_PARAMS,
  IFLOW_MODELS,
  IFLOW_REFRESH_BUFFER_SECONDS,
} from "./constants";

import type { ReasoningConfig } from "../types";

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope?: string;
}

interface UserInfoResponse {
  success: boolean;
  data: {
    apiKey: string;
    email?: string;
    phone?: string;
  };
}

/**
 * Create Basic Auth header for iFlow OAuth
 */
function createBasicAuth(): string {
  const authString = `${IFLOW_CLIENT_ID}:${IFLOW_CLIENT_SECRET}`;
  return Buffer.from(authString).toString("base64");
}

/**
 * Check if token needs refresh (with buffer)
 */
function isTokenExpired(expiresAt: Date): boolean {
  const bufferMs = IFLOW_REFRESH_BUFFER_SECONDS * 1000;
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
    if (IFLOW_SUPPORTED_PARAMS.has(key) && value !== undefined) {
      payload[key] = value;
    }
  }

  // Use stream value from params, or force if specified
  if (forceStream !== undefined) {
    payload.stream = forceStream;
  } else if (payload.stream === undefined) {
    payload.stream = true; // Default to streaming
  }

  // Handle reasoning parameter - convert to reasoning_effort for API
  // Support both OpenAI Responses API format (reasoning object) and legacy format
  const reasoning = params.reasoning as ReasoningConfig | undefined;
  const reasoningEffort = reasoning?.effort || params.reasoning_effort as string | undefined;
  
  if (reasoningEffort && reasoningEffort !== "none") {
    payload.reasoning_effort = reasoningEffort;
  }
  
  // Remove the reasoning object from payload (API uses reasoning_effort directly)
  delete payload.reasoning;

  // Clean tool schemas if present
  if (payload.tools && Array.isArray(payload.tools)) {
    if (payload.tools.length > 0) {
      payload.tools = cleanToolSchemas(
        payload.tools as Array<{ type: string; function: Record<string, unknown> }>
      );
    } else if (payload.stream === true) {
      // Inject dummy tool for empty arrays only when streaming
      payload.tools = [
        {
          type: "function",
          function: {
            name: "noop",
            description: "Placeholder tool to stabilise streaming",
            parameters: { type: "object" },
          },
        },
      ];
    }
  }

  return payload;
}

export const iflowConfig: ProviderConfig = {
  name: "iflow",
  displayName: "iFlow AI",
  supportedModels: IFLOW_MODELS,
};

export const iflowProvider: Provider = {
  config: iflowConfig,

  getAuthUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: IFLOW_CLIENT_ID,
      redirect_uri: IFLOW_REDIRECT_URI,
      response_type: "code",
      scope: "user:info",
      state,
    });
    return `${IFLOW_OAUTH_AUTHORIZE_URL}?${params}`;
  },

  async exchangeCode(code: string, redirectUri: string): Promise<OAuthResult> {
    const response = await fetch(IFLOW_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        Authorization: `Basic ${createBasicAuth()}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: IFLOW_CLIENT_ID,
        client_secret: IFLOW_CLIENT_SECRET,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Token exchange failed: ${response.status} ${error}`);
    }

    const tokens: TokenResponse = await response.json();

    // Fetch user info to get API key
    const userInfo = await fetchUserInfo(tokens.access_token);

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
      email: userInfo.email,
      apiKey: userInfo.apiKey,
    };
  },

  async refreshToken(refreshToken: string): Promise<OAuthResult> {
    const response = await fetch(IFLOW_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        Authorization: `Basic ${createBasicAuth()}`,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: IFLOW_CLIENT_ID,
        client_secret: IFLOW_CLIENT_SECRET,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Token refresh failed: ${response.status} ${error}`);
    }

    let tokens: TokenResponse = await response.json();

    // Handle wrapped response format
    if (
      (tokens as unknown as { data: TokenResponse }).data &&
      typeof (tokens as unknown as { data: TokenResponse }).data === "object"
    ) {
      tokens = (tokens as unknown as { data: TokenResponse }).data;
    }

    // Fetch new API key (may have changed)
    const userInfo = await fetchUserInfo(tokens.access_token);

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
      email: userInfo.email,
      apiKey: userInfo.apiKey,
    };
  },

  async getValidCredentials(account: ProviderAccount): Promise<string> {
    // Decrypt current tokens
    let apiKey = account.apiKey ? decrypt(account.apiKey) : "";
    const refreshTokenValue = decrypt(account.refreshToken);

    // Check if token needs refresh
    if (isTokenExpired(account.expiresAt)) {
      console.log(`Refreshing token for iFlow account ${account.id}`);

      try {
        // Refresh the token
        const newTokens = await this.refreshToken(refreshTokenValue);
        apiKey = newTokens.apiKey!;

        // Update database IMMEDIATELY (rotating token concern)
        await prisma.providerAccount.update({
          where: { id: account.id },
          data: {
            accessToken: encrypt(newTokens.accessToken),
            refreshToken: encrypt(newTokens.refreshToken),
            apiKey: encrypt(apiKey),
            expiresAt: newTokens.expiresAt,
            email: newTokens.email || account.email,
          },
        });

        console.log(`Token refreshed successfully for iFlow account ${account.id}`);
      } catch (error) {
        console.error(
          `Failed to refresh token for iFlow account ${account.id}:`,
          error
        );
        // If refresh fails but token not truly expired, try using existing key
        if (new Date() < account.expiresAt) {
          console.log("Using existing token as fallback");
        } else {
          throw error;
        }
      }
    }

    return apiKey;
  },

  async makeRequest(
    apiKey: string,
    account: ProviderAccount,
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

    const response = await fetch(`${IFLOW_API_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: stream ? "text/event-stream" : "application/json",
        "User-Agent": "iFlow-Cli",
      },
      body: JSON.stringify(requestPayload),
    });

    return response;
  },
};

/**
 * Fetch user info to get API key
 * CRITICAL: iFlow uses api_key for API calls, not access_token
 */
async function fetchUserInfo(
  accessToken: string
): Promise<{ apiKey: string; email: string }> {
  const url = `${IFLOW_USER_INFO_URL}?accessToken=${accessToken}`;

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch user info: ${response.status}`);
  }

  const result: UserInfoResponse = await response.json();

  if (!result.success) {
    throw new Error("iFlow user info request not successful");
  }

  const apiKey = result.data.apiKey?.trim();
  if (!apiKey) {
    throw new Error("Missing API key in user info response");
  }

  const email = result.data.email?.trim() || result.data.phone?.trim() || "";

  return { apiKey, email };
}
