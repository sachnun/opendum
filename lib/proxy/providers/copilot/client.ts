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
  COPILOT_CLIENT_ID,
  COPILOT_DEVICE_CODE_ENDPOINT,
  COPILOT_TOKEN_ENDPOINT,
  COPILOT_API_BASE_URL,
  COPILOT_USER_ENDPOINT,
  COPILOT_SCOPE,
  COPILOT_SUPPORTED_PARAMS,
  COPILOT_OPENCODE_USER_AGENT,
  COPILOT_OPENCODE_INTENT,
  COPILOT_MODELS,
  COPILOT_MODEL_MAP,
  COPILOT_POLLING_INTERVAL,
  COPILOT_DEVICE_CODE_EXPIRY,
  COPILOT_REFRESH_BUFFER_SECONDS,
} from "./constants";
import {
  convertResponsesInputToChatMessages,
  getCopilotSystemToolMode,
  injectCopilotChatSystemTool,
  injectCopilotResponsesSystemTool,
} from "./injection";

interface CopilotDeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

interface CopilotTokenResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

function isTokenExpired(expiresAt: Date): boolean {
  const bufferMs = COPILOT_REFRESH_BUFFER_SECONDS * 1000;
  return new Date().getTime() > expiresAt.getTime() - bufferMs;
}

function buildRequestPayload(
  params: Record<string, unknown>,
  forceStream?: boolean
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(params)) {
    if (COPILOT_SUPPORTED_PARAMS.has(key) && value !== undefined) {
      payload[key] = value;
    }
  }

  if (forceStream !== undefined) {
    payload.stream = forceStream;
  } else if (payload.stream === undefined) {
    payload.stream = true;
  }

  if (payload.stream === true) {
    payload.stream_options = { include_usage: true };
  }

  return payload;
}

function resolveCopilotModel(model: string): string {
  const normalizedModel = model.startsWith("copilot/")
    ? model.split("/", 2)[1] || model
    : model;

  return COPILOT_MODEL_MAP[normalizedModel] ?? normalizedModel;
}

function hasVisionInResponsesInput(
  input: Array<Record<string, unknown>> | undefined
): boolean {
  if (!Array.isArray(input)) {
    return false;
  }

  return input.some((item) => {
    const content = item.content;
    if (!Array.isArray(content)) {
      return false;
    }

    return content.some((part) => {
      if (!part || typeof part !== "object") {
        return false;
      }

      return (part as { type?: unknown }).type === "input_image";
    });
  });
}

function hasVisionInChatMessages(messages: ChatCompletionRequest["messages"]): boolean {
  if (!Array.isArray(messages)) {
    return false;
  }

  return messages.some((message) => {
    const content = message.content;
    if (!Array.isArray(content)) {
      return false;
    }

    return content.some((part) => {
      if (!part || typeof part !== "object") {
        return false;
      }

      const type = (part as { type?: unknown }).type;
      return type === "image_url" || type === "image";
    });
  });
}

function isCopilotVisionRequest(body: ChatCompletionRequest): boolean {
  return (
    hasVisionInResponsesInput(body._responsesInput) ||
    hasVisionInChatMessages(body.messages)
  );
}

function buildCopilotHeaders(
  accessToken: string,
  stream: boolean,
  initiator: "user" | "agent",
  visionRequest: boolean
): Record<string, string> {
  const headers: Record<string, string> = {
    "x-initiator": initiator,
    "User-Agent": COPILOT_OPENCODE_USER_AGENT,
    Authorization: `Bearer ${accessToken}`,
    "Openai-Intent": COPILOT_OPENCODE_INTENT,
    "Content-Type": "application/json",
    Accept: stream ? "text/event-stream" : "application/json",
  };

  if (visionRequest) {
    headers["Copilot-Vision-Request"] = "true";
  }

  return headers;
}

async function fetchCopilotIdentity(accessToken: string): Promise<string> {
  try {
    const response = await fetch(COPILOT_USER_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "opendum",
      },
      cache: "no-store",
    });

    if (!response.ok) {
      return "";
    }

    const user = (await response.json()) as { login?: string; email?: string };
    return (user.email || user.login || "").trim();
  } catch {
    return "";
  }
}

function normalizeTokenExpiry(expiresIn?: number): Date {
  if (typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0) {
    return new Date(Date.now() + expiresIn * 1000);
  }

  return new Date("2100-01-01T00:00:00.000Z");
}

export const copilotConfig: ProviderConfig = {
  name: "copilot",
  displayName: "GitHub Copilot",
  supportedModels: COPILOT_MODELS,
};

export const copilotProvider: Provider = {
  config: copilotConfig,

  async prepareRequest(account, body, endpoint) {
    const mode = await getCopilotSystemToolMode(account.id);

    const preparedBody: ChatCompletionRequest = {
      ...body,
      _copilotXInitiator: mode.xInitiator,
    };

    if (!mode.injectSystemTool) {
      return preparedBody;
    }

    if (endpoint === "responses" && Array.isArray(preparedBody._responsesInput)) {
      const injectedResponsesInput = injectCopilotResponsesSystemTool(
        preparedBody._responsesInput as Array<Record<string, unknown>>
      );

      preparedBody._responsesInput = injectedResponsesInput;

      preparedBody.messages = convertResponsesInputToChatMessages(
        injectedResponsesInput,
        typeof preparedBody.instructions === "string"
          ? preparedBody.instructions
          : undefined
      ) as ChatCompletionRequest["messages"];

      return preparedBody;
    }

    if (Array.isArray(preparedBody.messages)) {
      preparedBody.messages = injectCopilotChatSystemTool(
        preparedBody.messages as Array<Record<string, unknown>>
      ) as ChatCompletionRequest["messages"];
    }

    return preparedBody;
  },

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getAuthUrl(_state: string, _codeVerifier?: string): string {
    throw new Error(
      "Copilot uses Device Code Flow. Use initiateCopilotDeviceCodeFlow() instead."
    );
  },

  async exchangeCode(code: string): Promise<OAuthResult> {
    const response = await fetch(COPILOT_TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "User-Agent": "opendum",
      },
      body: new URLSearchParams({
        client_id: COPILOT_CLIENT_ID,
        device_code: code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Copilot token exchange failed: ${response.status} ${errorText}`);
    }

    const tokenData: CopilotTokenResponse = await response.json();
    if (!tokenData.access_token) {
      throw new Error(tokenData.error_description || tokenData.error || "Missing access token");
    }

    const identity = await fetchCopilotIdentity(tokenData.access_token);

    return {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || tokenData.access_token,
      expiresAt: normalizeTokenExpiry(tokenData.expires_in),
      email: identity,
    };
  },

  async refreshToken(refreshToken: string): Promise<OAuthResult> {
    const response = await fetch(COPILOT_TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "User-Agent": "opendum",
      },
      body: new URLSearchParams({
        client_id: COPILOT_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Copilot token refresh failed: ${response.status} ${errorText}`);
    }

    const tokenData: CopilotTokenResponse = await response.json();
    if (!tokenData.access_token) {
      throw new Error(tokenData.error_description || tokenData.error || "Missing access token");
    }

    const identity = await fetchCopilotIdentity(tokenData.access_token);

    return {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || refreshToken,
      expiresAt: normalizeTokenExpiry(tokenData.expires_in),
      email: identity,
    };
  },

  async getValidCredentials(account: ProviderAccount): Promise<string> {
    let accessToken = decrypt(account.accessToken);
    const refreshTokenValue = decrypt(account.refreshToken);

    if (isTokenExpired(account.expiresAt) && refreshTokenValue) {
      try {
        const refreshed = await this.refreshToken(refreshTokenValue);

        await prisma.providerAccount.update({
          where: { id: account.id },
          data: {
            accessToken: encrypt(refreshed.accessToken),
            refreshToken: encrypt(refreshed.refreshToken),
            expiresAt: refreshed.expiresAt,
            ...(refreshed.email ? { email: refreshed.email } : {}),
          },
        });

        accessToken = refreshed.accessToken;
      } catch (error) {
        console.error(`Failed to refresh Copilot token for account ${account.id}:`, error);
        if (new Date() >= account.expiresAt) {
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
    const modelName = body.model.includes("/") ? body.model.split("/").pop()! : body.model;
    const upstreamModel = resolveCopilotModel(modelName);
    const xInitiator = body._copilotXInitiator === "agent" ? "agent" : "user";
    const visionRequest = isCopilotVisionRequest(body);

    const requestPayload = buildRequestPayload(
      {
        ...body,
        model: upstreamModel,
      },
      stream
    );

    return fetch(`${COPILOT_API_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: buildCopilotHeaders(accessToken, stream, xInitiator, visionRequest),
      body: JSON.stringify(requestPayload),
    });
  },
};

export async function initiateCopilotDeviceCodeFlow(): Promise<{
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  verificationUrlComplete: string;
  expiresIn: number;
  interval: number;
}> {
  const response = await fetch(COPILOT_DEVICE_CODE_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": "opendum",
    },
    body: new URLSearchParams({
      client_id: COPILOT_CLIENT_ID,
      scope: COPILOT_SCOPE,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Copilot device code request failed: ${response.status} ${errorText}`);
  }

  const data: CopilotDeviceCodeResponse = await response.json();

  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUrl: data.verification_uri,
    verificationUrlComplete: data.verification_uri_complete || data.verification_uri,
    expiresIn: data.expires_in || COPILOT_DEVICE_CODE_EXPIRY,
    interval: data.interval || COPILOT_POLLING_INTERVAL,
  };
}

export async function pollCopilotDeviceCodeAuthorization(
  deviceCode: string
): Promise<OAuthResult | { pending: true } | { error: string }> {
  const response = await fetch(COPILOT_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": "opendum",
    },
    body: new URLSearchParams({
      client_id: COPILOT_CLIENT_ID,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    return { error: `Copilot auth failed (HTTP ${response.status}): ${errorText}` };
  }

  const data: CopilotTokenResponse = await response.json();

  if (data.access_token) {
    const identity = await fetchCopilotIdentity(data.access_token);

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || data.access_token,
      expiresAt: normalizeTokenExpiry(data.expires_in),
      email: identity,
    };
  }

  if (data.error === "authorization_pending" || data.error === "slow_down") {
    return { pending: true };
  }

  if (data.error === "expired_token") {
    return { error: "Device code expired. Please start again." };
  }

  if (data.error === "access_denied") {
    return { error: "Authorization was denied by the user." };
  }

  return {
    error: data.error_description || data.error || "Unknown authentication error",
  };
}
