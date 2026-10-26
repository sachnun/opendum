import { Effect } from "effect";
import { OAuth } from "@opendum/providers/core/oauth";
import { OAuthProvider, type Json, type ProviderOptions } from "@opendum/providers/core/provider";
import { Value } from "@opendum/providers/core/helpers";
import { JSONPoster } from "@opendum/providers/core/http";
import type {
  ProviderAccount,
  ProviderFailure,
  ProviderRequest,
  RefreshedCredentials,
  ProviderCredentialFailure,
} from "@opendum/providers/types";

import { CLINE_BASE_URL } from "@opendum/providers/endpoints";

const CLINE_API_BASE = CLINE_BASE_URL;
const CLINE_REFRESH_PATH = "/auth/refresh";
const CLINE_CHAT_PATH = "/chat/completions";
const ACCESS_TTL_MS = 60 * 60 * 1000;

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

export class ClineProvider extends OAuthProvider {
  readonly name = "cline";
  protected readonly refreshBufferMs = 5 * 60 * 1000;
  private readonly oauth: OAuth;

  constructor(options: ProviderOptions) {
    super(options);
    this.oauth = new OAuth({
      provider: "cline",
      tokenUrl: `${CLINE_API_BASE}${CLINE_REFRESH_PATH}`,
      transport: this.transport,
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
  }

  protected exchange(
    refreshToken: string,
    account: ProviderAccount
  ): Effect.Effect<RefreshedCredentials, ProviderCredentialFailure> {
    return this.oauth.exchange(refreshToken, account);
  }

  makeRequest(request: ProviderRequest): Effect.Effect<Response, ProviderFailure> {
    const payload: Json = this.filterParams(request.body, SUPPORTED_CLINE);
    payload.model = this.upstream(Value.string(request.body.model));
    payload.stream = request.stream;
    return JSONPoster.withAuth({
      provider: this.name,
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
