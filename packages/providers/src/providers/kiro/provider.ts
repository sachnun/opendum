import type { Registry } from "@opendum/models/runtime";
import { jsonResponse, randomId, stringValue } from "#providers/lib/helpers.ts";
import type { UpstreamTransport } from "#providers/api/http.ts";
import { KIRO_REFRESH_ENDPOINT } from "#providers/api/endpoints.ts";
import {
  KiroParserState,
  buildKiroRequest,
  convertKiroEventsToCompletion,
  kiroApiUrlForAccount,
  kiroThinkingRequested,
  lastModelSegment,
  normalizeKiroTier,
  parseKiroJsonEvents,
  type Json,
} from "#providers/providers/kiro/transform.ts";
import { kiroSseStream } from "#providers/providers/kiro/stream.ts";
import type {
  CredentialRefresher,
  Provider,
  ProviderAccount,
  ProviderRequest,
  RefreshedCredentials,
  RefreshBufferProvider,
} from "#providers/model/types.ts";

export type KiroOptions = {
  registry: Registry;
  transport: UpstreamTransport;
};

export class KiroProvider implements Provider, CredentialRefresher, RefreshBufferProvider {
  readonly name = "kiro";
  private readonly registry: Registry;
  private readonly transport: UpstreamTransport;

  constructor(options: KiroOptions) {
    this.registry = options.registry;
    this.transport = options.transport;
  }

  refreshBuffer(): number {
    return 5 * 60 * 1000;
  }

  async refreshCredentials(refreshToken: string, _account: ProviderAccount): Promise<RefreshedCredentials> {
    const resp = await this.transport.direct(KIRO_REFRESH_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "KiroIDE" },
      body: JSON.stringify({ refreshToken: refreshToken.trim() }),
    });
    const text = await resp.text();
    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(`kiro token refresh failed: ${resp.status} ${text.slice(0, 1024)}`);
    }
    const token = JSON.parse(text) as { accessToken?: string; refreshToken?: string; expiresIn?: number };
    const accessToken = (token.accessToken ?? "").trim();
    if (!accessToken) throw new Error("kiro token refresh returned empty access token");
    const nextRefresh = token.refreshToken || refreshToken;
    const expiresIn = token.expiresIn && token.expiresIn > 0 ? token.expiresIn : 3600;
    const tier = await this.fetchSubscriptionTier(accessToken);
    return { accessToken, refreshToken: nextRefresh, expiresAt: new Date(Date.now() + expiresIn * 1000), tier };
  }

  private async fetchSubscriptionTier(accessToken: string): Promise<string> {
    try {
      const resp = await this.transport.direct("https://q.us-east-1.amazonaws.com/", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken.trim()}`,
          "Content-Type": "application/x-amz-json-1.0",
          Accept: "application/json",
          "x-amz-target": "AmazonCodeWhispererService.GetUsageLimits",
          "User-Agent": "KiroIDE-0.7.45",
        },
        body: JSON.stringify({ origin: "AI_EDITOR" }),
      });
      if (resp.status < 200 || resp.status >= 300) return "";
      const payload = (await resp.json()) as Json;
      const record = ((payload.data ?? payload) as Json) ?? {};
      const sub = record.subscriptionInfo;
      if (sub === null || typeof sub !== "object" || Array.isArray(sub)) return "";
      return normalizeKiroTier(stringValue((sub as Json).type), stringValue((sub as Json).subscriptionTitle));
    } catch {
      return "";
    }
  }

  async makeRequest(request: ProviderRequest): Promise<Response> {
    const body = request.body;
    const modelName = lastModelSegment(stringValue(body.model));
    const thinkingEnabled = kiroThinkingRequested(this.registry, body);
    const payload = buildKiroRequest(this.registry, body);
    const accountId = request.account.accountId?.trim();
    if (accountId) payload.profileArn = accountId;

    const resp = await this.transport.direct(kiroApiUrlForAccount(request.account), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${request.credentials.trim()}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent":
          "aws-sdk-js/3.738.0 ua/2.1 lang/go api/codewhisperer#3.738.0 m/E KiroIDE",
        "x-amz-user-agent": "aws-sdk-js/3.738.0 KiroIDE",
        "x-amzn-codewhisperer-optout": "true",
        "x-amzn-kiro-agent-mode": "vibe",
        "amz-sdk-invocation-id": randomId("kiro"),
        "amz-sdk-request": "attempt=1; max=1",
        Connection: "close",
      },
      body: JSON.stringify(payload),
    });
    if (resp.status < 200 || resp.status >= 300) return resp;
    request.onUpstreamResponseStart?.();
    if (!resp.body) {
      return jsonResponse(502, { error: { message: "Kiro response stream is empty", type: "api_error" } });
    }

    if (request.stream) {
      return new Response(kiroSseStream(resp.body, modelName, thinkingEnabled), {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }
    const rawText = await resp.text();
    const events = parseKiroJsonEvents(rawText, new KiroParserState());
    return jsonResponse(200, convertKiroEventsToCompletion(events, modelName, thinkingEnabled));
  }
}

export { normalizeKiroTier, parseKiroJsonEvents, convertKiroEventsToCompletion };
