import type { ProviderAccount } from "../../../db/schema.js";
import { decrypt } from "../../../encryption.js";
import type {
  ChatCompletionRequest,
  OAuthResult,
  Provider,
  ProviderConfig,
} from "../types.js";
import { DEFAULT_PROVIDER_TIMEOUTS } from "../types.js";
import { fetchWithTimeout } from "../../timeout.js";
import { getAdaptiveTimeout } from "../../adaptive-timeout.js";
import { getUpstreamModelName, getProviderModelSet } from "../../models.js";
import {
  getWorkersAiChatUrl,
  WORKERS_AI_SUPPORTED_PARAMS,
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
    if (WORKERS_AI_SUPPORTED_PARAMS.has(key) && value !== undefined) {
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
  timeouts: {
    ...DEFAULT_PROVIDER_TIMEOUTS,
    nonStreamMs: 30_000,
  },
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

    const requestPayload = buildRequestPayload(
      {
        ...body,
        model: upstreamModel,
      },
      stream
    );

    const fallbackMs = stream
      ? workersAiConfig.timeouts.streamMs
      : workersAiConfig.timeouts.nonStreamMs;
    const timeoutMs = await getAdaptiveTimeout(
      workersAiConfig.name, body.model, stream, fallbackMs
    );
    return fetchWithTimeout(getWorkersAiChatUrl(accountId), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
        Accept: stream ? "text/event-stream" : "application/json",
      },
      body: JSON.stringify(requestPayload),
    }, timeoutMs);
  },
};
