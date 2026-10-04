import type { Registry } from "@opendum/models/runtime";
import { stringValue } from "#providers/lib/helpers.ts";
import { postJSONWithHeaders, type UpstreamTransport } from "#providers/api/http.ts";
import type {
  CredentialRefresher,
  Provider,
  ProviderAccount,
  ProviderRequest,
  RefreshedCredentials,
  RefreshBufferProvider,
} from "#providers/model/types.ts";

import { CLINE_BASE_URL } from "#providers/api/endpoints.ts";

const CLINE_API_BASE = CLINE_BASE_URL;
const CLINE_REFRESH_PATH = "/auth/refresh";
const CLINE_CHAT_PATH = "/chat/completions";
const CLINE_ACCESS_TTL_MS = 60 * 60 * 1000;
const CLINE_REFRESH_BUFFER_MS = 5 * 60 * 1000;

const CLINE_REQUEST_HEADERS: Record<string, string> = {
  "HTTP-Referer": "https://cline.bot",
  "X-Title": "Pi",
  "X-CLIENT-TYPE": "cline-sdk",
};

export const SUPPORTED_CLINE = new Set([
  "model", "messages", "temperature", "top_p", "max_tokens", "max_completion_tokens", "stream",
  "stream_options", "tools", "tool_choice", "parallel_tool_calls", "presence_penalty",
  "frequency_penalty", "n", "stop", "seed", "response_format", "reasoning", "reasoning_effort",
]);

export type ClineOptions = {
  registry: Registry;
  transport: UpstreamTransport;
};

export class ClineProvider implements Provider, CredentialRefresher, RefreshBufferProvider {
  readonly name = "cline";
  private readonly registry: Registry;
  private readonly transport: UpstreamTransport;

  constructor(options: ClineOptions) {
    this.registry = options.registry;
    this.transport = options.transport;
  }

  refreshBuffer(): number {
    return CLINE_REFRESH_BUFFER_MS;
  }

  async refreshCredentials(refreshToken: string, _account: ProviderAccount): Promise<RefreshedCredentials> {
    const resp = await this.transport.direct(`${CLINE_API_BASE}${CLINE_REFRESH_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ refreshToken: refreshToken.trim(), grantType: "refresh_token" }),
    });
    const text = await resp.text();
    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(`cline token refresh failed: ${resp.status} ${text.slice(0, 1024)}`);
    }
    const parsed = JSON.parse(text) as {
      data?: { accessToken?: string; refreshToken?: string };
    };
    const accessToken = parsed.data?.accessToken ?? "";
    if (!accessToken.trim()) {
      throw new Error("cline token refresh returned empty access token");
    }
    const nextRefresh = parsed.data?.refreshToken || refreshToken;
    return {
      accessToken: `workos:${accessToken}`,
      refreshToken: nextRefresh,
      expiresAt: new Date(Date.now() + CLINE_ACCESS_TTL_MS),
    };
  }

  async makeRequest(request: ProviderRequest): Promise<Response> {
    const payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(request.body)) {
      if (SUPPORTED_CLINE.has(key) && value !== undefined && value !== null) payload[key] = value;
    }
    let model = stringValue(request.body.model);
    if (model.startsWith("cline/")) model = model.slice("cline/".length);
    payload.model = this.registry.upstreamModelName(model, "cline");
    payload.stream = request.stream;
    return postJSONWithHeaders(
      this.transport.direct,
      `${CLINE_API_BASE}${CLINE_CHAT_PATH}`,
      request.credentials,
      payload,
      request.stream,
      CLINE_REQUEST_HEADERS,
      request.onUpstreamResponseStart
    );
  }
}
