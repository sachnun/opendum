import { Effect, Result } from "effect";
import { Responses, Value } from "@opendum/providers/core/helpers";
import { RequestFailure } from "@opendum/providers/core/http";
import { OAuth } from "@opendum/providers/core/oauth";
import { OAuthProvider, type ProviderOptions } from "@opendum/providers/core/provider";
import type {
  ProviderAccount,
  ProviderFailure,
  ProviderRequest,
  RefreshedCredentials,
  ProviderCredentialFailure,
} from "@opendum/providers/types";
import { PERCH_APP_URL } from "@opendum/providers/auth/perch/constants";

import {
  ACCESS_TTL_MS,
  MANUAL_OPTION_IDS,
  MODEL_CALL_PATH,
  PerchAuth,
  PerchModels,
  REFRESH_BUFFER_MS,
  TURN_TICKET_HEADER,
  UpstreamError,
  type Json,
} from "@opendum/providers/upstreams/perch/auth";
import { PerchPayload } from "@opendum/providers/upstreams/perch/payload";
import { PerchCompletion, PerchStream, sseGenerator } from "@opendum/providers/upstreams/perch/stream";

export class PerchProvider extends OAuthProvider {
  readonly name = "perch";
  protected readonly refreshBufferMs = REFRESH_BUFFER_MS;
  private readonly auth: PerchAuth;
  private readonly oauth: OAuth;

  constructor(options: ProviderOptions) {
    super(options);
    this.oauth = new OAuth({
      provider: "perch",
      tokenUrl: async () => {
        const config = await this.auth.config();
        if (Result.isFailure(config)) return "";
        return `${config.success.supabaseUrl}/auth/v1/token?grant_type=refresh_token`;
      },
      transport: options.transport,
      request: async (refreshToken) => {
        const headers = await this.auth.tokenHeaders();
        const values = Result.isFailure(headers) ? {} : headers.success;
        return {
          method: "POST",
          headers: { ...values, Accept: "application/json" },
          body: JSON.stringify({ refresh_token: refreshToken.trim() }),
        };
      },
      parse: (payload, refreshToken) => {
        const token = payload as {
          access_token?: string;
          refresh_token?: string;
          expires_at?: number;
          expires_in?: number;
        };
        const accessToken = (token.access_token ?? "").trim();
        if (!accessToken) return Result.fail("perch token refresh returned empty access token");
        let expiresAt = new Date(Date.now() + ACCESS_TTL_MS);
        if ((token.expires_at ?? 0) > 0) expiresAt = new Date(Math.trunc((token.expires_at as number) * 1000));
        else if ((token.expires_in ?? 0) > 0) expiresAt = new Date(Date.now() + (token.expires_in as number) * 1000);
        const nextRefresh = (token.refresh_token ?? "").trim() || refreshToken.trim();
        return Result.succeed({ accessToken, refreshToken: nextRefresh, expiresAt });
      },
    });
    this.auth = new PerchAuth(options.transport);
  }

  protected exchange(
    refreshToken: string,
    account: ProviderAccount
  ): Effect.Effect<RefreshedCredentials, ProviderCredentialFailure> {
    return this.oauth.exchange(refreshToken, account);
  }

  makeRequest(request: ProviderRequest): Effect.Effect<Response, ProviderFailure> {
    const requestedModel = Value.string(request.body.model);
    const upstream = PerchModels.alias(this.registry, requestedModel);
    const optionId = MANUAL_OPTION_IDS[upstream];
    if (!optionId) {
      return Effect.succeed(
        Responses.json(400, {
          error: {
            message: `Model "${requestedModel}" is not supported for Perch. Supported models: ${PerchModels.supported(
              this.registry
            )}.`,
            type: "invalid_request_error",
            param: "model",
            code: "unsupported_perch_model",
          },
        })
      );
    }

    const includeReasoning = Value.bool(request.body._includeReasoning);
    const url = `${PERCH_APP_URL}${MODEL_CALL_PATH}`;
    const auth = this.auth;
    const transport = this.transport;

    return RequestFailure.normalize(
      "perch",
      Effect.gen(function* () {
        const ticketResult = yield* Effect.tryPromise({
          try: () => auth.turnTicket(request.credentials),
          catch: (cause) => RequestFailure.transport("perch", cause),
        });
        if (Result.isFailure(ticketResult)) {
          return yield* Effect.fail(RequestFailure.transport("perch", new Error(ticketResult.failure)));
        }
        const { ticket, runId: ticketRunId } = ticketResult.success;
        const runId = ticketRunId.trim() || PerchAuth.runId();

        let attribution: Json | null = null;
        const ids = yield* Effect.tryPromise({
          try: () => auth.sessionIds(request.account, request.credentials),
          catch: (cause) => RequestFailure.transport("perch", cause),
        });
        if (ids && ids.userId && ids.workspaceId) {
          attribution = {
            userId: ids.userId,
            workspaceId: ids.workspaceId,
            runId,
            lane: "chat",
            source: "cli",
            billingMultiplier: null,
          };
        }

        const perchRequest: Json = { lane: "chat", messages: PerchPayload.messages(request.body) };
        const tools = PerchPayload.tools(request.body);
        if (tools) {
          perchRequest.tools = tools;
          perchRequest.toolChoice = "auto";
        }
        if (request.body.temperature !== undefined && request.body.temperature !== null) {
          perchRequest.temperature = request.body.temperature;
        }
        const maxTokens = PerchModels.firstNonNil(
          request.body.max_tokens,
          request.body.max_completion_tokens
        );
        if (maxTokens !== null) perchRequest.maxOutputTokens = maxTokens;

        const { level, reasoningEnabled } = PerchModels.effort(request.body);
        const payload: Json = {
          request: perchRequest,
          runId,
          lane: "chat",
          strictManual: false,
          preferredModelId: null,
          avoidModelIds: [],
          attribution,
          clientSurface: "cli",
          manualModelOptionId: optionId,
          roostModelChoice: "standard",
          roostReasoning: reasoningEnabled,
          effort: { level, orchestration: false },
        };

        const resp = yield* Effect.tryPromise({
          try: () =>
            transport.direct(url, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${request.credentials.trim()}`,
                [TURN_TICKET_HEADER]: ticket,
                "User-Agent": PerchAuth.userAgent(),
                Accept: "text/event-stream",
              },
              body: JSON.stringify(payload),
            }),
          catch: (cause) => RequestFailure.transport("perch", cause, url),
        });
        request.onResponseStart?.();
        if (resp.status < 200 || resp.status >= 300) return resp;

        if (request.stream && resp.body) {
          return new Response(SseStream.of(resp.body, requestedModel, includeReasoning), {
            status: 200,
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            },
          });
        }
        const completion = yield* Effect.tryPromise({
          try: () => PerchCompletion.fromResponse(resp, requestedModel, includeReasoning),
          catch: (cause) => cause,
        }).pipe(
          Effect.catchIf(
            (cause): cause is UpstreamError => cause instanceof UpstreamError,
            (error) =>
              Effect.succeed(
                Responses.json(error.quota ? 429 : 502, {
                  error: {
                    message: error.message,
                    type: error.quota ? "rate_limit_error" : "api_error",
                  },
                })
              )
          )
        );
        return Responses.json(200, completion);
      })
    );
  }
}

class SseStream {
  static of(
    source: ReadableStream<Uint8Array>,
    model: string,
    includeReasoning: boolean
  ): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const iterator = sseGenerator(source, model, includeReasoning)[Symbol.asyncIterator]();
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await iterator.next();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(value));
      },
      async cancel() {
        await iterator.return?.(undefined);
      },
    });
  }
}

export { PerchStream };
export { PerchCompletion as PerchCompletionReader };
