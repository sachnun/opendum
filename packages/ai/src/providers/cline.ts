import type { Provider, ProviderRequestOptions, RefreshedCredentials } from "./base.js";
import type { ModelRegistry } from "../registry/registry.js";
import type { ProviderAccount } from "@opendum/database";

const CLINE_API_BASE = "https://api.cline.bot/api/v1";
const CLINE_REFRESH_PATH = "/auth/refresh";
const CLINE_CHAT_PATH = "/chat/completions";
const CLINE_ACCESS_TTL_MS = 60 * 60 * 1000; // 1 hour
const CLINE_REFRESH_BUFFER_SECONDS = 300; // 5 mins

const clineRequestHeaders: Record<string, string> = {
  "HTTP-Referer": "https://cline.bot",
  "X-Title": "Pi",
  "X-CLIENT-TYPE": "cline-sdk",
};

const supportedClineParams = new Set([
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
  "parallel_tool_calls",
  "presence_penalty",
  "frequency_penalty",
  "n",
  "stop",
  "seed",
  "response_format",
  "reasoning",
  "reasoning_effort",
]);

export class ClineProvider implements Provider {
  public name = "cline";

  constructor(private registry: ModelRegistry) {}

  getRefreshBuffer(): number {
    return CLINE_REFRESH_BUFFER_SECONDS;
  }

  async refreshCredentials(
    refreshToken: string,
    _account: ProviderAccount
  ): Promise<RefreshedCredentials> {
    const res = await fetch(`${CLINE_API_BASE}${CLINE_REFRESH_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        refreshToken: refreshToken.trim(),
        grantType: "refresh_token",
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`cline token refresh failed: ${res.status} ${text}`);
    }

    const data: any = await res.json();
    const accessToken = data?.data?.accessToken;
    if (!accessToken) {
      throw new Error("cline token refresh returned empty access token");
    }

    return {
      accessToken: `workos:${accessToken}`,
      refreshToken: data?.data?.refreshToken || refreshToken,
      expiresAt: new Date(Date.now() + CLINE_ACCESS_TTL_MS),
    };
  }

  async makeRequest(options: ProviderRequestOptions): Promise<Response> {
    const { credentials, body, stream, signal } = options;
    const rawModel = String(body.model || "");
    const model = rawModel.startsWith("cline/")
      ? rawModel.slice("cline/".length)
      : rawModel;
    const upstreamModel = this.registry.upstreamModelName(model, "cline");

    const payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      if (supportedClineParams.has(key) && value !== undefined && value !== null) {
        payload[key] = value;
      }
    }
    payload.model = upstreamModel;
    payload.stream = stream;

    return await fetch(`${CLINE_API_BASE}${CLINE_CHAT_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: stream ? "text/event-stream" : "application/json",
        Authorization: `Bearer ${credentials?.trim()}`,
        ...clineRequestHeaders,
      },
      body: JSON.stringify(payload),
      signal,
    });
  }
}
