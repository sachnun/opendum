import type { Registry } from "@opendum/models/runtime";
import {
  boolFromAny,
  defaultStringValue,
  jsonResponse,
  numberFromAny,
  stringValue,
} from "#providers/lib/helpers.ts";
import type { UpstreamTransport } from "#providers/api/http.ts";
import type {
  CredentialRefresher,
  Provider,
  ProviderAccount,
  ProviderRequest,
  RefreshedCredentials,
  RefreshBufferProvider,
} from "#providers/model/types.ts";

import { PERCH_APP_URL } from "#providers/api/endpoints.ts";
import { PerchUpstreamError, perchSseToChatCompletion, perchSseToChatStream } from "#providers/providers/perch/sse.ts";
import {
  PERCH_ACCESS_TTL_MS,
  PERCH_MANUAL_OPTION_IDS,
  PERCH_MODEL_CALL_PATH,
  PERCH_REFRESH_BUFFER_MS,
  PERCH_TURN_TICKET_HEADER,
  type Json,
  fetchPerchAuthConfig,
  firstNonNil,
  perchEffortFromBody,
  perchMessages,
  perchModelAlias,
  perchRunId,
  perchSupportedModels,
  perchTokenHeaders,
  perchTools,
  perchTurnTicket,
  perchUserAgent,
  sessionIdsForAccount,
} from "#providers/providers/perch/request.ts";

export { PerchUpstreamError } from "#providers/providers/perch/sse.ts";

export type PerchOptions = {
  registry: Registry;
  transport: UpstreamTransport;
};

export class PerchProvider implements Provider, CredentialRefresher, RefreshBufferProvider {
  readonly name = "perch";
  private readonly registry: Registry;
  private readonly transport: UpstreamTransport;

  constructor(options: PerchOptions) {
    this.registry = options.registry;
    this.transport = options.transport;
  }

  refreshBuffer(): number {
    return PERCH_REFRESH_BUFFER_MS;
  }

  async refreshCredentials(refreshToken: string, _account: ProviderAccount): Promise<RefreshedCredentials> {
    const config = await fetchPerchAuthConfig(this.transport);
    const resp = await this.transport.direct(
      `${config.supabaseUrl}/auth/v1/token?grant_type=refresh_token`,
      {
        method: "POST",
        headers: { ...perchTokenHeaders(config), Accept: "application/json" },
        body: JSON.stringify({ refresh_token: refreshToken.trim() }),
      }
    );
    const text = await resp.text();
    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(`perch token refresh failed: ${resp.status} ${text.slice(0, 1024)}`);
    }
    const token = JSON.parse(text) as {
      access_token?: string;
      refresh_token?: string;
      expires_at?: number;
      expires_in?: number;
    };
    const accessToken = (token.access_token ?? "").trim();
    if (!accessToken) throw new Error("perch token refresh returned empty access token");
    let expiresAt = new Date(Date.now() + PERCH_ACCESS_TTL_MS);
    if ((token.expires_at ?? 0) > 0) expiresAt = new Date(Math.trunc((token.expires_at as number) * 1000));
    else if ((token.expires_in ?? 0) > 0) expiresAt = new Date(Date.now() + (token.expires_in as number) * 1000);
    const nextRefresh = (token.refresh_token ?? "").trim() || refreshToken.trim();
    return { accessToken, refreshToken: nextRefresh, expiresAt };
  }

  async makeRequest(request: ProviderRequest): Promise<Response> {
    const requestedModel = stringValue(request.body.model);
    const upstream = perchModelAlias(this.registry, requestedModel);
    const optionId = PERCH_MANUAL_OPTION_IDS[upstream];
    if (!optionId) {
      return jsonResponse(400, {
        error: {
          message: `Model "${requestedModel}" is not supported for Perch. Supported models: ${perchSupportedModels(
            this.registry
          )}.`,
          type: "invalid_request_error",
          param: "model",
          code: "unsupported_perch_model",
        },
      });
    }
    const includeReasoning = boolFromAny(request.body._includeReasoning);

    const { ticket, runId: ticketRunId } = await perchTurnTicket(this.transport, request.credentials);
    const runId = ticketRunId.trim() || perchRunId();
    let attribution: Json | null = null;
    const ids = await sessionIdsForAccount(this.transport, request.account, request.credentials);
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

    const perchRequest: Json = { lane: "chat", messages: perchMessages(request.body) };
    const tools = perchTools(request.body);
    if (tools) {
      perchRequest.tools = tools;
      perchRequest.toolChoice = "auto";
    }
    if (request.body.temperature !== undefined && request.body.temperature !== null) {
      perchRequest.temperature = request.body.temperature;
    }
    const maxTokens = firstNonNil(request.body.max_tokens, request.body.max_completion_tokens);
    if (maxTokens !== null) perchRequest.maxOutputTokens = maxTokens;

    const { level, reasoningEnabled } = perchEffortFromBody(request.body);
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

    const resp = await this.transport.direct(`${PERCH_APP_URL}${PERCH_MODEL_CALL_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${request.credentials.trim()}`,
        [PERCH_TURN_TICKET_HEADER]: ticket,
        "User-Agent": perchUserAgent(),
        Accept: "text/event-stream",
      },
      body: JSON.stringify(payload),
    });
    request.onUpstreamResponseStart?.();
    if (resp.status < 200 || resp.status >= 300) return resp;

    if (request.stream && resp.body) {
      return new Response(perchSseToChatStream(resp.body, requestedModel, includeReasoning), {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }
    try {
      const completion = await perchSseToChatCompletion(resp, requestedModel, includeReasoning);
      return jsonResponse(200, completion);
    } catch (error) {
      if (error instanceof PerchUpstreamError) {
        return jsonResponse(
          error.quota ? 429 : 502,
          { error: { message: error.message, type: error.quota ? "rate_limit_error" : "api_error" } }
        );
      }
      throw error;
    }
  }
}

export function defaultPerchValue(value: unknown, fallback: string): string {
  return defaultStringValue(value, fallback);
}

export function perchNumber(value: unknown): number {
  return numberFromAny(value);
}
