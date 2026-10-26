import { Effect } from "effect";
import type { Registry } from "@opendum/models/runtime";
import { Value } from "../core/helpers.js";
import { JSONPoster, type UpstreamTransport } from "../core/http.js";
import { OAuthBase } from "../core/oauth.js";
import type { Provider, ProviderFailure, ProviderRequest } from "../types.js";

import { CLINE_BASE_URL } from "../endpoints.js";

const CLINE_API_BASE = CLINE_BASE_URL;
const CLINE_REFRESH_PATH = "/auth/refresh";
const CLINE_CHAT_PATH = "/chat/completions";
const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

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

export class ClineProvider extends OAuthBase implements Provider {
  readonly name = "cline";
  private readonly registry: Registry;
  private readonly transport: UpstreamTransport;

  constructor(options: ClineOptions) {
    super({
      provider: "cline",
      tokenUrl: `${CLINE_API_BASE}${CLINE_REFRESH_PATH}`,
      transport: options.transport,
      request: (refreshToken) => ({
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ refreshToken: refreshToken.trim(), grantType: "refresh_token" }),
      }),
      parse: (payload, refreshToken) => {
        const data = (payload as { data?: { accessToken?: string; refreshToken?: string } }).data;
        const accessToken = data?.accessToken ?? "";
        if (!accessToken.trim()) {
          throw new Error("cline token refresh returned empty access token");
        }
        return {
          accessToken: `workos:${accessToken}`,
          refreshToken: data?.refreshToken || refreshToken,
          expiresAt: new Date(Date.now() + ACCESS_TTL_MS),
        };
      },
    });
    this.registry = options.registry;
    this.transport = options.transport;
  }

  refreshBuffer(): number {
    return REFRESH_BUFFER_MS;
  }

  makeRequest(request: ProviderRequest): Effect.Effect<Response, ProviderFailure> {
    const payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(request.body)) {
      if (SUPPORTED_CLINE.has(key) && value !== undefined && value !== null) payload[key] = value;
    }
    let model = Value.string(request.body.model);
    if (model.startsWith("cline/")) model = model.slice("cline/".length);
    payload.model = this.registry.upstream(model, "cline");
    payload.stream = request.stream;
    return JSONPoster.withAuth({
      provider: "cline",
      fetchFn: this.transport.direct,
      url: `${CLINE_API_BASE}${CLINE_CHAT_PATH}`,
      bearer: request.credentials,
      payload,
      stream: request.stream,
      headers: CLINE_REQUEST_HEADERS,
      onStart: request.onResponseStart,
    });
  }
}
