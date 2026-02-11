import type { ProviderAccount } from "@prisma/client";
import { decrypt } from "@/lib/encryption";
import type {
  ChatCompletionRequest,
  OAuthResult,
  Provider,
  ProviderConfig,
} from "../types";
import {
  OPENROUTER_API_BASE_URL,
  OPENROUTER_MODELS,
  OPENROUTER_MODEL_MAP,
  OPENROUTER_SUPPORTED_PARAMS,
} from "./constants";

const API_KEY_ACCOUNT_EXPIRY_MS = 365 * 24 * 60 * 60 * 1000;

function resolveOpenRouterModel(model: string): string {
  const normalizedModel = model.startsWith("openrouter/")
    ? model.split("/", 2)[1] || model
    : model;

  return OPENROUTER_MODEL_MAP[normalizedModel] ?? normalizedModel;
}

function buildRequestPayload(
  params: Record<string, unknown>,
  forceStream?: boolean
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(params)) {
    if (OPENROUTER_SUPPORTED_PARAMS.has(key) && value !== undefined) {
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

export const openRouterConfig: ProviderConfig = {
  name: "openrouter",
  displayName: "OpenRouter",
  supportedModels: OPENROUTER_MODELS,
};

export const openRouterProvider: Provider = {
  config: openRouterConfig,

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getAuthUrl(_state: string, _codeVerifier?: string): string {
    throw new Error("OpenRouter uses API key authentication only.");
  },

  async exchangeCode(): Promise<OAuthResult> {
    throw new Error("OpenRouter uses API key authentication only.");
  },

  async refreshToken(refreshToken: string): Promise<OAuthResult> {
    const token = refreshToken.trim();
    if (!token) {
      throw new Error("Missing OpenRouter API key");
    }

    return {
      accessToken: token,
      refreshToken: token,
      expiresAt: new Date(Date.now() + API_KEY_ACCOUNT_EXPIRY_MS),
      email: "",
    };
  },

  async getValidCredentials(account: ProviderAccount): Promise<string> {
    const apiKey = decrypt(account.accessToken).trim();

    if (!apiKey) {
      throw new Error("Missing OpenRouter API key on account");
    }

    return apiKey;
  },

  async makeRequest(
    apiKey: string,
    _account: ProviderAccount,
    body: ChatCompletionRequest,
    stream: boolean
  ): Promise<Response> {
    const upstreamModel = resolveOpenRouterModel(body.model);

    const requestPayload = buildRequestPayload(
      {
        ...body,
        model: upstreamModel,
      },
      stream
    );

    return fetch(`${OPENROUTER_API_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: stream ? "text/event-stream" : "application/json",
      },
      body: JSON.stringify(requestPayload),
    });
  },
};
