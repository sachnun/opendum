import {
  IFLOW_OAUTH_TOKEN_URL,
  IFLOW_USER_INFO_URL,
  IFLOW_API_BASE_URL,
  IFLOW_CLIENT_ID,
  IFLOW_CLIENT_SECRET,
  SUPPORTED_PARAMS,
  REFRESH_BUFFER_SECONDS,
} from "./constants";
import { encrypt, decrypt } from "@/lib/encryption";
import { prisma } from "@/lib/db";

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

interface IFlowCredentials {
  accessToken: string;
  refreshToken: string;
  apiKey: string;
  expiresAt: Date;
  email?: string;
}

/**
 * Create Basic Auth header for iFlow OAuth
 */
function createBasicAuth(): string {
  const authString = `${IFLOW_CLIENT_ID}:${IFLOW_CLIENT_SECRET}`;
  return Buffer.from(authString).toString("base64");
}

/**
 * Exchange authorization code for tokens
 */
export async function exchangeCodeForTokens(
  code: string,
  redirectUri: string
): Promise<TokenResponse> {
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

  return response.json();
}

/**
 * Refresh access token using refresh token
 */
export async function refreshAccessToken(
  refreshToken: string
): Promise<TokenResponse> {
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

  const data = await response.json();
  
  // Handle wrapped response format
  if (data.data && typeof data.data === "object") {
    return data.data;
  }
  
  return data;
}

/**
 * Fetch user info to get API key
 * CRITICAL: iFlow uses api_key for API calls, not access_token
 */
export async function fetchUserInfo(
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

/**
 * Check if token needs refresh (with buffer)
 */
export function isTokenExpired(expiresAt: Date): boolean {
  const bufferMs = REFRESH_BUFFER_SECONDS * 1000;
  return new Date().getTime() > expiresAt.getTime() - bufferMs;
}

/**
 * Get valid API key for an iFlow account, refreshing if needed
 */
export async function getValidApiKey(accountId: string): Promise<string> {
  const account = await prisma.iflowAccount.findUnique({
    where: { id: accountId },
  });

  if (!account) {
    throw new Error("iFlow account not found");
  }

  // Decrypt current tokens
  let apiKey = decrypt(account.apiKey);
  const refreshToken = decrypt(account.refreshToken);

  // Check if token needs refresh
  if (isTokenExpired(account.expiresAt)) {
    console.log(`Refreshing token for account ${accountId}`);
    
    try {
      // Refresh the token
      const newTokens = await refreshAccessToken(refreshToken);
      
      // Fetch new API key (may have changed)
      const userInfo = await fetchUserInfo(newTokens.access_token);
      apiKey = userInfo.apiKey;
      
      // Calculate new expiry
      const expiresAt = new Date(Date.now() + newTokens.expires_in * 1000);
      
      // Update database IMMEDIATELY (rotating token concern)
      await prisma.iflowAccount.update({
        where: { id: accountId },
        data: {
          accessToken: encrypt(newTokens.access_token),
          refreshToken: encrypt(newTokens.refresh_token),
          apiKey: encrypt(apiKey),
          expiresAt,
          email: userInfo.email || account.email,
        },
      });
      
      console.log(`Token refreshed successfully for account ${accountId}`);
    } catch (error) {
      console.error(`Failed to refresh token for account ${accountId}:`, error);
      // If refresh fails but token not truly expired, try using existing key
      if (new Date() < account.expiresAt) {
        console.log("Using existing token as fallback");
      } else {
        throw error;
      }
    }
  }

  return apiKey;
}

/**
 * Clean tool schemas to prevent API errors
 */
export function cleanToolSchemas(tools: any[]): any[] {
  return tools.map((tool) => {
    const cleaned = { ...tool };
    
    if (cleaned.function) {
      // Remove unsupported properties
      delete cleaned.function.strict;
      
      if (cleaned.function.parameters) {
        delete cleaned.function.parameters.additionalProperties;
        
        // Recursively clean nested properties
        if (cleaned.function.parameters.properties) {
          cleanSchemaProperties(cleaned.function.parameters.properties);
        }
      }
    }
    
    return cleaned;
  });
}

function cleanSchemaProperties(properties: Record<string, any>): void {
  for (const key of Object.keys(properties)) {
    const prop = properties[key];
    delete prop.additionalProperties;
    
    if (prop.properties) {
      cleanSchemaProperties(prop.properties);
    }
    
    if (prop.items?.properties) {
      cleanSchemaProperties(prop.items.properties);
    }
  }
}

/**
 * Build request payload with only supported parameters
 */
export function buildRequestPayload(params: Record<string, any>, forceStream?: boolean): Record<string, any> {
  const payload: Record<string, any> = {};
  
  for (const [key, value] of Object.entries(params)) {
    if (SUPPORTED_PARAMS.has(key) && value !== undefined) {
      payload[key] = value;
    }
  }
  
  // Use stream value from params, or force if specified
  if (forceStream !== undefined) {
    payload.stream = forceStream;
  } else if (payload.stream === undefined) {
    payload.stream = true; // Default to streaming
  }
  
  // Clean tool schemas if present
  if (payload.tools && Array.isArray(payload.tools)) {
    if (payload.tools.length > 0) {
      payload.tools = cleanToolSchemas(payload.tools);
    } else if (payload.stream) {
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

/**
 * Make a request to iFlow API (supports both streaming and non-streaming)
 */
export async function makeIFlowRequest(
  apiKey: string,
  model: string,
  payload: Record<string, any>,
  stream: boolean = true
): Promise<Response> {
  // Strip provider prefix from model name
  const modelName = model.includes("/") ? model.split("/").pop()! : model;
  
  const requestPayload = buildRequestPayload({
    ...payload,
    model: modelName,
  }, stream);
  
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
}
