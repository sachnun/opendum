import type { Registry } from "@opendum/models/runtime";
import type { OpendumRedis } from "@opendum/redis";
import { jsonResponse, stringValue } from "#providers/lib/helpers.ts";
import { responsesSseToChatStream } from "#providers/transform/responses.ts";
import {
  extractAccountIdFromJwt,
  extractTierFromJwt,
  lastModelSegment,
  parseCodexQuotaHeaders,
} from "#providers/providers/codex/parse.ts";
import { buildCodexPayload } from "#providers/providers/codex/payload.ts";
import { responsesStreamToCompletion } from "#providers/providers/codex/completion.ts";

export { responsesStreamToCompletion } from "#providers/providers/codex/completion.ts";
export { SUPPORTED_CODEX } from "#providers/providers/codex/payload.ts";
import type { UpstreamTransport } from "#providers/api/http.ts";
import type {
  CredentialRefresher,
  Provider,
  ProviderAccount,
  ProviderRequest,
  RefreshedCredentials,
  RefreshBufferProvider,
} from "#providers/model/types.ts";

import {
  CODEX_API_BASE_URL,
  CODEX_CLIENT_ID,
  CODEX_ORIGINATOR,
  CODEX_TOKEN_ENDPOINT,
} from "#providers/api/endpoints.ts";
const CODEX_REFRESH_BUFFER_MS = 5 * 60 * 1000;

export type CodexOptions = {
  registry: Registry;
  transport: UpstreamTransport;
  redis?: OpendumRedis | null;
  onAccountId?: (accountId: string) => void;
};

export class CodexProvider implements Provider, CredentialRefresher, RefreshBufferProvider {
  readonly name = "codex";
  private readonly registry: Registry;
  private readonly transport: UpstreamTransport;
  private readonly redis: OpendumRedis | null;
  private readonly onAccountId: ((accountId: string) => void) | undefined;

  constructor(options: CodexOptions) {
    this.registry = options.registry;
    this.transport = options.transport;
    this.redis = options.redis ?? null;
    this.onAccountId = options.onAccountId;
  }

  refreshBuffer(): number {
    return CODEX_REFRESH_BUFFER_MS;
  }

  async refreshCredentials(refreshToken: string, _account: ProviderAccount): Promise<RefreshedCredentials> {
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken.trim(),
      client_id: CODEX_CLIENT_ID,
    });
    const resp = await this.transport.direct(CODEX_TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: form.toString(),
    });
    const text = await resp.text();
    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(`codex token refresh failed: ${resp.status} ${text.slice(0, 1024)}`);
    }
    const token = JSON.parse(text) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      id_token?: string;
    };
    const accessToken = token.access_token ?? "";
    if (!accessToken) throw new Error("codex token refresh returned empty access token");
    const nextRefresh = token.refresh_token || refreshToken;
    const expiresIn = token.expires_in && token.expires_in > 0 ? token.expires_in : 3600;
    let accountId = extractAccountIdFromJwt(accessToken);
    if (!accountId && token.id_token) accountId = extractAccountIdFromJwt(token.id_token);
    let tier = "";
    if (token.id_token) tier = extractTierFromJwt(token.id_token);
    if (!tier) tier = extractTierFromJwt(accessToken);
    return {
      accessToken,
      refreshToken: nextRefresh,
      expiresAt: new Date(Date.now() + expiresIn * 1000),
      tier,
      accountId,
    };
  }

  async makeRequest(request: ProviderRequest): Promise<Response> {
    const modelName = this.resolveModel(stringValue(request.body.model));
    const account = request.account;
    let accountId = account.accountId?.trim() ?? "";
    if (!accountId) {
      const extracted = extractAccountIdFromJwt(request.credentials);
      if (extracted) {
        accountId = extracted;
        this.onAccountId?.(extracted);
      }
    }
    if (!this.isModelAllowed(modelName)) {
      return jsonResponse(400, {
        error: {
          message: `Model "${modelName}" is not supported for Codex when using a ChatGPT account. Use one of: ${this.supportedModelNames().join(
            ", "
          )}.`,
          type: "invalid_request_error",
          param: "model",
          code: "unsupported_codex_chatgpt_model",
        },
      });
    }

    const payload = buildCodexPayload(request.body, modelName, true);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${request.credentials.trim()}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      originator: CODEX_ORIGINATOR,
      "User-Agent": `opencode/1.14.28 (${process.platform} ${process.platform}; ${process.arch})`,
    };
    if (accountId) headers["ChatGPT-Account-Id"] = accountId;
    const sessionId = stringValue(request.body._sessionId);
    if (sessionId) headers.session_id = sessionId;

    const resp = await this.transport.direct(CODEX_API_BASE_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (resp.status < 200 || resp.status >= 300) return resp;
    request.onUpstreamResponseStart?.();
    void this.updateQuotaFromHeaders(account.id, resp.headers);
    if (request.stream && resp.body) {
      return new Response(responsesSseToChatStream(resp.body, modelName), {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }
    const text = await resp.text();
    return jsonResponse(200, responsesStreamToCompletion(text, modelName));
  }

  private async updateQuotaFromHeaders(accountId: string, headers: Headers): Promise<void> {
    if (!this.redis || !accountId) return;
    const snapshot = parseCodexQuotaHeaders(headers);
    if (!snapshot) return;
    snapshot.status = "success";
    snapshot.source = "headers";
    snapshot.fetchedAt = Date.now();
    try {
      await this.redis.set(`opendum:quota:codex:snapshot:${accountId}`, JSON.stringify(snapshot), {
        EX: 15 * 60,
      });
    } catch {
      return;
    }
  }

  private isModelAllowed(model: string): boolean {
    const normalized = model.trim().toLowerCase();
    for (const [canonical, upstream] of this.registry.providerModelMap("codex")) {
      if (canonical.toLowerCase() === normalized || upstream.toLowerCase() === normalized) return true;
    }
    return false;
  }

  private supportedModelNames(): string[] {
    const values = new Set<string>();
    for (const [canonical, upstream] of this.registry.providerModelMap("codex")) {
      if (canonical) values.add(canonical);
      if (upstream) values.add(upstream);
    }
    return [...values].sort((a, b) => a.localeCompare(b));
  }

  private resolveModel(model: string): string {
    return this.registry.upstreamModelName(lastModelSegment(model), "codex");
  }
}

