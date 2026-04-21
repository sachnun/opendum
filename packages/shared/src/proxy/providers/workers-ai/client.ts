import type { ProviderAccount } from "../../../db/schema.js";
import { decrypt } from "../../../encryption.js";
import type {
  ChatCompletionRequest,
  OAuthResult,
  Provider,
  ProviderConfig,
} from "../types.js";
import { getUpstreamModelName, getProviderModelSet } from "../../models.js";
import { convertImageUrlsToBase64 } from "../../images.js";
import {
  getWorkersAiChatUrl,
  SUPPORTED_PARAMS,
} from "./constants.js";

const API_KEY_ACCOUNT_EXPIRY_MS = 365 * 24 * 60 * 60 * 1000;

function resolveWorkersAiModel(model: string): string {
  return getUpstreamModelName(model, "workers_ai");
}

function buildRequestPayload(
  params: Record<string, unknown>,
  forceStream?: boolean
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(params)) {
    if (SUPPORTED_PARAMS.has(key) && value !== undefined) {
      payload[key] = value;
    }
  }

  if (forceStream !== undefined) {
    payload.stream = forceStream;
  } else if (payload.stream === undefined) {
    payload.stream = true;
  }

  return payload;
}

export const workersAiConfig: ProviderConfig = {
  name: "workers_ai",
  displayName: "Workers AI",
  supportedModels: getProviderModelSet("workers_ai"),
};

export const workersAiProvider: Provider = {
  config: workersAiConfig,

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getAuthUrl(_state: string, _codeVerifier?: string): string {
    throw new Error("Workers AI uses API key authentication only.");
  },

  async exchangeCode(): Promise<OAuthResult> {
    throw new Error("Workers AI uses API key authentication only.");
  },

  async refreshToken(refreshToken: string): Promise<OAuthResult> {
    const token = refreshToken.trim();
    if (!token) {
      throw new Error("Missing Workers AI API token");
    }

    return {
      accessToken: token,
      refreshToken: token,
      expiresAt: new Date(Date.now() + API_KEY_ACCOUNT_EXPIRY_MS),
      email: "",
    };
  },

  async getValidCredentials(account: ProviderAccount): Promise<string> {
    const apiToken = decrypt(account.accessToken).trim();

    if (!apiToken) {
      throw new Error("Missing Workers AI API token on account");
    }

    return apiToken;
  },

  async makeRequest(
    apiToken: string,
    account: ProviderAccount,
    body: ChatCompletionRequest,
    stream: boolean
  ): Promise<Response> {
    const accountId = account.accountId;
    if (!accountId) {
      throw new Error("Missing Cloudflare Account ID on Workers AI account");
    }

    const upstreamModel = resolveWorkersAiModel(body.model);

    // Workers AI rejects image URLs — convert to base64 data URIs
    const messages = await convertImageUrlsToBase64(body.messages);

    const requestPayload = buildRequestPayload(
      {
        ...body,
        messages,
        model: upstreamModel,
      },
      stream
    );

    return fetch(getWorkersAiChatUrl(accountId), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
        Accept: stream ? "text/event-stream" : "application/json",
      },
      body: JSON.stringify(requestPayload),
    });
  },
};
