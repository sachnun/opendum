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
  CEREBRAS_API_BASE_URL,
  CEREBRAS_SUPPORTED_PARAMS,
} from "./constants.js";

const API_KEY_ACCOUNT_EXPIRY_MS = 365 * 24 * 60 * 60 * 1000;

function resolveCerebrasModel(model: string): string {
  return getUpstreamModelName(model, "cerebras");
}

function buildRequestPayload(
  params: Record<string, unknown>,
  forceStream?: boolean
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(params)) {
    if (CEREBRAS_SUPPORTED_PARAMS.has(key) && value !== undefined) {
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

export const cerebrasConfig: ProviderConfig = {
  name: "cerebras",
  displayName: "Cerebras",
  supportedModels: getProviderModelSet("cerebras"),
  timeouts: DEFAULT_PROVIDER_TIMEOUTS,
};

export const cerebrasProvider: Provider = {
  config: cerebrasConfig,

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getAuthUrl(_state: string, _codeVerifier?: string): string {
    throw new Error("Cerebras uses API key authentication only.");
  },

  async exchangeCode(): Promise<OAuthResult> {
    throw new Error("Cerebras uses API key authentication only.");
  },

  async refreshToken(refreshToken: string): Promise<OAuthResult> {
    const token = refreshToken.trim();
    if (!token) {
      throw new Error("Missing Cerebras API key");
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
      throw new Error("Missing Cerebras API key on account");
    }

    return apiKey;
  },

  async makeRequest(
    apiKey: string,
    _account: ProviderAccount,
    body: ChatCompletionRequest,
    stream: boolean
  ): Promise<Response> {
    const upstreamModel = resolveCerebrasModel(body.model);

    const requestPayload = buildRequestPayload(
      {
        ...body,
        model: upstreamModel,
      },
      stream
    );

    const fallbackMs = stream
      ? cerebrasConfig.timeouts.streamMs
      : cerebrasConfig.timeouts.nonStreamMs;
    const timeoutMs = await getAdaptiveTimeout(
      cerebrasConfig.name, body.model, stream, fallbackMs
    );
    return fetchWithTimeout(`${CEREBRAS_API_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: stream ? "text/event-stream" : "application/json",
      },
      body: JSON.stringify(requestPayload),
    }, timeoutMs);
  },
};
