import type { Provider, ProviderRequestOptions, RefreshedCredentials } from "./base.js";
import type { ModelRegistry } from "../registry/registry.js";
import type { ProviderAccount } from "@opendum/database";

const QODER_BASE_URL = "https://unroxy.koyeb.app/api.qoder.com/api";
const QODER_REFRESH_PATH = "/v1/auth/refresh";
const QODER_CHAT_PATH = "/v1/chat/completions";
const QODER_ACCESS_TTL_MS = 24 * 60 * 60 * 1000;
const QODER_REFRESH_BUFFER_SECONDS = 3600;

const supportedQoderParams = new Set([
  "model",
  "messages",
  "temperature",
  "top_p",
  "max_tokens",
  "max_completion_tokens",
  "stream",
  "stream_options",
  "tools",
  "tool_choice",
  "presence_penalty",
  "frequency_penalty",
  "n",
  "stop",
  "seed",
  "response_format",
  "reasoning",
  "reasoning_effort",
]);

export class QoderProvider implements Provider {
  public name = "qoder";

  constructor(private registry: ModelRegistry) {}

  getRefreshBuffer(): number {
    return QODER_REFRESH_BUFFER_SECONDS;
  }

  async refreshCredentials(
    refreshToken: string,
    _account: ProviderAccount
  ): Promise<RefreshedCredentials> {
    const res = await fetch(`${QODER_BASE_URL}${QODER_REFRESH_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ refreshToken: refreshToken.trim() }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`qoder token refresh failed: ${res.status} ${text}`);
    }

    const data: any = await res.json();
    return {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken || refreshToken,
      expiresAt: new Date(Date.now() + (data.expiresIn ? data.expiresIn * 1000 : QODER_ACCESS_TTL_MS)),
    };
  }

  async makeRequest(options: ProviderRequestOptions): Promise<Response> {
    const { credentials, body, stream, signal } = options;
    const rawModel = String(body.model || "");
    const upstreamModel = this.registry.upstreamModelName(rawModel, "qoder");

    const payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      if (supportedQoderParams.has(key) && value !== undefined && value !== null) {
        payload[key] = value;
      }
    }
    payload.model = upstreamModel;
    payload.stream = stream;

    return await fetch(`${QODER_BASE_URL}${QODER_CHAT_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: stream ? "text/event-stream" : "application/json",
        Authorization: `Bearer ${credentials?.trim()}`,
      },
      body: JSON.stringify(payload),
      signal,
    });
  }
}
