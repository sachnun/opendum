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
  KILO_CODE_API_BASE_URL,
  KILO_CODE_SUPPORTED_PARAMS,
} from "./constants.js";

const API_KEY_ACCOUNT_EXPIRY_MS = 365 * 24 * 60 * 60 * 1000;

function resolveKiloCodeModel(model: string): string {
  const normalizedModel = model.startsWith("kilo_code/")
    ? model.slice("kilo_code/".length)
    : model;

  return getUpstreamModelName(normalizedModel, "kilo_code");
}

function buildRequestPayload(
  params: Record<string, unknown>,
  forceStream?: boolean
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(params)) {
    if (KILO_CODE_SUPPORTED_PARAMS.has(key) && value !== undefined) {
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

export const kiloCodeConfig: ProviderConfig = {
  name: "kilo_code",
  displayName: "Kilo Code",
  supportedModels: getProviderModelSet("kilo_code"),
  timeouts: DEFAULT_PROVIDER_TIMEOUTS,
};

export const kiloCodeProvider: Provider = {
  config: kiloCodeConfig,

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getAuthUrl(_state: string, _codeVerifier?: string): string {
    throw new Error("Kilo Code uses API key authentication only.");
  },

  async exchangeCode(): Promise<OAuthResult> {
    throw new Error("Kilo Code uses API key authentication only.");
  },

  async refreshToken(refreshToken: string): Promise<OAuthResult> {
    const token = refreshToken.trim();
    if (!token) {
      throw new Error("Missing Kilo Code API key");
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
      throw new Error("Missing Kilo Code API key on account");
    }

    return apiKey;
  },

  async makeRequest(
    apiKey: string,
    _account: ProviderAccount,
    body: ChatCompletionRequest,
    stream: boolean
  ): Promise<Response> {
    const upstreamModel = resolveKiloCodeModel(body.model);

    const requestPayload = buildRequestPayload(
      {
        ...body,
        model: upstreamModel,
      },
      stream
    );

    const fallbackMs = stream
      ? kiloCodeConfig.timeouts.streamMs
      : kiloCodeConfig.timeouts.nonStreamMs;
    const timeoutMs = await getAdaptiveTimeout(
      kiloCodeConfig.name, body.model, stream, fallbackMs
    );
    return fetchWithTimeout(`${KILO_CODE_API_BASE_URL}/chat/completions`, {
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
