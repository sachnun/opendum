import { Effect } from "effect";
import type { Registry } from "@opendum/models/runtime";
import { stringValue } from "../core/helpers.js";
import { postJSONWithHeaders, type UpstreamTransport } from "../core/http.js";
import { ProviderCredentialFailure } from "../core/errors.js";
import { OAuth } from "../core/oauth.js";
import type {
  CredentialRefresher,
  Provider,
  ProviderAccount,
  ProviderFailure,
  ProviderRequest,
  RefreshedCredentials,
  RefreshBufferProvider,
} from "../types.js";

import { CLINE_BASE_URL } from "../endpoints.js";

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
  private readonly exchange: OAuth;

  constructor(options: ClineOptions) {
    this.registry = options.registry;
    this.transport = options.transport;
    this.exchange = new OAuth({
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
          expiresAt: new Date(Date.now() + CLINE_ACCESS_TTL_MS),
        };
      },
    });
  }

  refreshBuffer(): number {
    return CLINE_REFRESH_BUFFER_MS;
  }

  refreshCredentials(
    refreshToken: string,
    account: ProviderAccount
  ): Effect.Effect<RefreshedCredentials, ProviderCredentialFailure> {
    return this.exchange.exchange(refreshToken, account);
  }

  makeRequest(request: ProviderRequest): Effect.Effect<Response, ProviderFailure> {
    const payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(request.body)) {
      if (SUPPORTED_CLINE.has(key) && value !== undefined && value !== null) payload[key] = value;
    }
    let model = stringValue(request.body.model);
    if (model.startsWith("cline/")) model = model.slice("cline/".length);
    payload.model = this.registry.upstream(model, "cline");
    payload.stream = request.stream;
    return postJSONWithHeaders(
      "cline",
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
