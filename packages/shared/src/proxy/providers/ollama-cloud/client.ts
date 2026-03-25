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
import {
  OLLAMA_CLOUD_API_BASE_URL,
  OLLAMA_CLOUD_SUPPORTED_PARAMS,
} from "./constants.js";
import { getUpstreamModelName, getProviderModelSet } from "../../models.js";

const API_KEY_ACCOUNT_EXPIRY_MS = 365 * 24 * 60 * 60 * 1000;

// Timeout for fetching individual image URLs (10 seconds)
const IMAGE_FETCH_TIMEOUT_MS = 10_000;

/**
 * Convert HTTP(S) image URLs in message content to base64 data URIs.
 *
 * Ollama Cloud does not support image URLs — only base64-encoded data.
 * This function walks through all messages, finds `image_url` content
 * parts with HTTP(S) URLs, fetches them, and replaces the URL with a
 * base64 data URI.  Already-encoded data URIs are left untouched.
 *
 * If a fetch fails the original URL is kept so the provider returns
 * a clear error rather than silently dropping the image.
 */
async function convertImageUrlsToBase64(
  messages: ChatCompletionRequest["messages"]
): Promise<ChatCompletionRequest["messages"]> {
  // Quick scan: bail early if there are no image_url parts with HTTP(S) URLs
  let hasHttpImageUrl = false;
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const part of msg.content as Array<{ type: string; [k: string]: unknown }>) {
      if (part.type !== "image_url") continue;
      const imageUrl = part.image_url as { url?: string } | undefined;
      if (imageUrl?.url && !imageUrl.url.startsWith("data:")) {
        hasHttpImageUrl = true;
        break;
      }
    }
    if (hasHttpImageUrl) break;
  }
  if (!hasHttpImageUrl) return messages;

  const result: ChatCompletionRequest["messages"] = [];

  for (const msg of messages) {
    if (!Array.isArray(msg.content)) {
      result.push(msg);
      continue;
    }

    const parts = msg.content as Array<{ type: string; [k: string]: unknown }>;
    const newParts: Array<{ type: string; [k: string]: unknown }> = [];

    for (const part of parts) {
      if (part.type !== "image_url") {
        newParts.push(part);
        continue;
      }

      const imageUrl = part.image_url as { url?: string; detail?: string } | undefined;
      if (!imageUrl?.url || imageUrl.url.startsWith("data:")) {
        newParts.push(part);
        continue;
      }

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
        const response = await fetch(imageUrl.url, { signal: controller.signal });
        clearTimeout(timer);

        if (!response.ok) {
          // Keep original URL — Ollama Cloud will surface an error
          newParts.push(part);
          continue;
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        const contentType = response.headers.get("content-type") || "image/png";
        const base64 = buffer.toString("base64");
        const dataUri = `data:${contentType};base64,${base64}`;

        newParts.push({
          ...part,
          image_url: { ...imageUrl, url: dataUri },
        });
      } catch {
        // Fetch failed (timeout, network error, etc.) — keep original
        newParts.push(part);
      }
    }

    result.push({ ...msg, content: newParts });
  }

  return result;
}

function resolveOllamaCloudModel(model: string): string {
  const normalizedModel = model.startsWith("ollama_cloud/")
    ? model.split("/", 2)[1] || model
    : model;

  return getUpstreamModelName(normalizedModel, "ollama_cloud");
}

function buildRequestPayload(
  params: Record<string, unknown>,
  forceStream?: boolean
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(params)) {
    if (OLLAMA_CLOUD_SUPPORTED_PARAMS.has(key) && value !== undefined) {
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

export const ollamaCloudConfig: ProviderConfig = {
  name: "ollama_cloud",
  displayName: "Ollama Cloud",
  supportedModels: getProviderModelSet("ollama_cloud"),
  timeouts: DEFAULT_PROVIDER_TIMEOUTS,
};

export const ollamaCloudProvider: Provider = {
  config: ollamaCloudConfig,

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getAuthUrl(_state: string, _codeVerifier?: string): string {
    throw new Error("Ollama Cloud uses API key authentication only.");
  },

  async exchangeCode(): Promise<OAuthResult> {
    throw new Error("Ollama Cloud uses API key authentication only.");
  },

  async refreshToken(refreshToken: string): Promise<OAuthResult> {
    const token = refreshToken.trim();
    if (!token) {
      throw new Error("Missing Ollama Cloud API key");
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
      throw new Error("Missing Ollama Cloud API key on account");
    }

    return apiKey;
  },

  async makeRequest(
    apiKey: string,
    _account: ProviderAccount,
    body: ChatCompletionRequest,
    stream: boolean
  ): Promise<Response> {
    const upstreamModel = resolveOllamaCloudModel(body.model);

    // Ollama Cloud rejects image URLs — convert to base64 data URIs
    const messages = await convertImageUrlsToBase64(body.messages);

    const requestPayload = buildRequestPayload(
      {
        ...body,
        messages,
        model: upstreamModel,
      },
      stream
    );

    const fallbackMs = stream
      ? ollamaCloudConfig.timeouts.streamMs
      : ollamaCloudConfig.timeouts.nonStreamMs;
    const timeoutMs = await getAdaptiveTimeout(
      ollamaCloudConfig.name, body.model, stream, fallbackMs
    );
    return fetchWithTimeout(`${OLLAMA_CLOUD_API_BASE_URL}/chat/completions`, {
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
