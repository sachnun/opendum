import { createHash } from "node:crypto";
import type { Registry } from "@opendum/models/runtime";
import type { OpendumRedis } from "@opendum/redis";

import { cloneAnyMap, contentToText, jsonResponse, randomId, stringValue } from "#providers/lib/helpers.ts";
import { convertImageURLsToBase64 } from "#providers/lib/images.ts";
import type { UpstreamTransport } from "#providers/api/http.ts";
import { anySlice, type Json, randomUuid } from "#providers/providers/antigravity/config.ts";
import { fetchAccountInfo, setGoogleHeaders } from "#providers/providers/antigravity/account.ts";
import { openAiToGemini } from "#providers/providers/antigravity/contents.ts";
import { transformAntigravityPayload as transformPayload } from "#providers/providers/antigravity/contents-normalize.ts";
import {
  configBool,
  normalizeBodyForModel,
  resolveAntigravityGemini3ModelVariant,
  resolveModel,
  shouldSetAnthropicBeta,
} from "#providers/providers/antigravity/model-config.ts";
import {
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_CLIENT_SECRET,
  ANTIGRAVITY_DEFAULT_PROJECT,
  ANTIGRAVITY_ENDPOINTS,
  CLAUDE_BETA_HEADER,
  GOOGLE_OAUTH_TOKEN_ENDPOINT,
  type AntigravityRuntime,
} from "#providers/providers/antigravity/runtime.ts";
import { cacheSignature, cacheSignaturesFromResponse, getCachedSignature } from "#providers/providers/antigravity/signature.ts";
import {
  buildToolSchemaMap,
  geminiSseToOpenAiStream,
  geminiStreamToOpenAiCompletionImpl,
  geminiToOpenAiCompletion,
  peekRetiredNotice,
  retiredResponse,
  sanitizeToolSchemaKeys,
  unwrapGeminiResponse,
  wrapCodeAssistPayload,
} from "#providers/providers/antigravity/transform.ts";
import type {
  CredentialRefresher,
  Provider,
  ProviderAccount,
  ProviderRequest,
  RefreshedCredentials,
  RefreshBufferProvider,
} from "#providers/model/types.ts";

export type { ToolSchemaMap } from "#providers/providers/antigravity/transform.ts";

function toNumericSessionId(sessionId: string): string {
  const value = sessionId.trim();
  if (!value) return "";
  if (/^-?\d+$/.test(value)) return value;
  const hash = createHash("sha256").update(value).digest();
  const n = hash.readBigUInt64BE(0) & 0x7fffffffffffffffn;
  return `-${n.toString()}`;
}

function stableSessionId(body: Json): string {
  const messages = anySlice(body.messages);
  for (const raw of messages) {
    const msg = (raw ?? {}) as Json;
    if (stringValue(msg.role) !== "user") continue;
    const text = contentToText(msg.content);
    if (!text.trim()) continue;
    const hex = createHash("sha256").update(text).digest("hex").slice(0, 32);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return randomId("session");
}

export type AntigravityOptions = {
  registry: Registry;
  transport: UpstreamTransport;
  redis?: OpendumRedis | null;
  persistAccountInfo?: (accountId: string, info: { projectId: string; tier: string; email: string }) => void;
};

export class AntigravityProvider implements Provider, CredentialRefresher, RefreshBufferProvider {
  readonly name = "antigravity";
  private readonly rt: AntigravityRuntime;

  constructor(options: AntigravityOptions) {
    this.rt = {
      name: this.name,
      registry: options.registry,
      transport: options.transport,
      redis: options.redis ?? null,
      persistAccountInfo: options.persistAccountInfo,
    };
  }

  refreshBuffer(): number {
    return 60 * 60 * 1000;
  }

  async refreshCredentials(refreshToken: string, _account: ProviderAccount): Promise<RefreshedCredentials> {
    const form = new URLSearchParams({
      client_id: ANTIGRAVITY_CLIENT_ID,
      client_secret: ANTIGRAVITY_CLIENT_SECRET,
      refresh_token: refreshToken.trim(),
      grant_type: "refresh_token",
    });
    const resp = await this.rt.transport.direct(GOOGLE_OAUTH_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const text = await resp.text();
    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(`antigravity token refresh failed: ${resp.status} ${text.slice(0, 1024)}`);
    }
    const token = JSON.parse(text) as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!token.access_token) throw new Error("antigravity token refresh returned empty access token");
    const nextRefresh = token.refresh_token || refreshToken;
    const expiresIn = token.expires_in && token.expires_in > 0 ? token.expires_in : 3600;
    const info = await fetchAccountInfo(this.rt, token.access_token);
    return {
      accessToken: token.access_token,
      refreshToken: nextRefresh,
      expiresAt: new Date(Date.now() + expiresIn * 1000),
      projectId: info.projectId,
      tier: info.tier,
      paidTier: info.paidTier,
      email: info.email,
    };
  }

  getCachedSignature(model: string, sessionId: string, thoughtText: string): Promise<string> {
    return getCachedSignature(this.rt, model, sessionId, thoughtText);
  }

  cacheSignature(model: string, sessionId: string, thoughtText: string, signature: string): Promise<void> {
    return cacheSignature(this.rt, model, sessionId, thoughtText, signature);
  }

  cacheSignaturesFromResponse(response: Json, model: string, sessionId: string): Promise<void> {
    return cacheSignaturesFromResponse(this.rt, response, model, sessionId);
  }

  transformAntigravityPayload(payload: Json, model: string, sessionId: string): Promise<void> {
    return transformPayload(this.rt, payload, model, sessionId);
  }

  async makeRequest(request: ProviderRequest): Promise<Response> {
    const body = request.body;
    let projectId = request.account.projectId?.trim() ?? "";
    if (!projectId) projectId = ANTIGRAVITY_DEFAULT_PROJECT;
    if (!projectId) {
      const info = await fetchAccountInfo(this.rt, request.credentials);
      projectId = info.projectId || ANTIGRAVITY_DEFAULT_PROJECT;
      if (projectId && request.account.id) {
        const tier = info.paidTier || info.tier;
        this.rt.persistAccountInfo?.(request.account.id, { projectId, tier, email: info.email });
      }
    }
    if (!projectId) throw new Error("antigravity account missing projectId");

    let modelName = resolveModel(this.rt, stringValue(body.model));
    modelName = resolveAntigravityGemini3ModelVariant(this.rt, modelName, body);
    let normalizedBody = normalizeBodyForModel(this.rt, body, modelName);
    const messages = normalizedBody.messages;
    if (Array.isArray(messages) && modelName.includes("claude")) {
      normalizedBody = cloneAnyMap(normalizedBody);
      normalizedBody.messages = await convertImageURLsToBase64(this.rt.transport.direct, messages);
    }

    const clientSession = stringValue(normalizedBody._sessionId);
    let sessionId = clientSession ? toNumericSessionId(clientSession) : toNumericSessionId(stableSessionId(normalizedBody));
    if (!sessionId) sessionId = toNumericSessionId(randomUuid());

    const geminiPayload = openAiToGemini(normalizedBody);
    await this.transformAntigravityPayload(geminiPayload, modelName, sessionId);
    const toolSchemas = buildToolSchemaMap(geminiPayload.tools);
    if (!configBool(this.rt, modelName, "strict_tool_schema")) sanitizeToolSchemaKeys(toolSchemas);

    const requestPayload = wrapCodeAssistPayload(projectId, modelName, geminiPayload);
    let actualStream = request.stream;
    if (!modelName.includes("gemini") && !request.stream) actualStream = true;
    else if (configBool(this.rt, modelName, "force_stream_non_stream") && !request.stream) actualStream = true;
    const action = actualStream ? "streamGenerateContent?alt=sse" : "generateContent";
    const encoded = JSON.stringify(requestPayload);

    let lastResp: Response | null = null;
    let lastErr: unknown = null;
    for (const endpoint of ANTIGRAVITY_ENDPOINTS) {
      const headers: Record<string, string> = {};
      setGoogleHeaders(headers, request.credentials, actualStream);
      if (shouldSetAnthropicBeta(this.rt, modelName)) headers["anthropic-beta"] = CLAUDE_BETA_HEADER;
      let resp: Response;
      try {
        resp = await this.rt.transport.direct(`${endpoint}/v1internal:${action}`, {
          method: "POST",
          headers,
          body: encoded,
        });
      } catch (error) {
        lastErr = error;
        continue;
      }
      if (resp.status === 429) {
        request.onUpstreamResponseStart?.();
        return resp;
      }
      if ([401, 403, 404].includes(resp.status) || resp.status >= 500) {
        lastResp = resp;
        continue;
      }
      if (resp.status < 200 || resp.status >= 300) {
        request.onUpstreamResponseStart?.();
        return resp;
      }
      request.onUpstreamResponseStart?.();
      lastResp = resp;
      lastErr = null;
      break;
    }
    const resp = lastResp;
    if (lastErr || !resp || resp.status < 200 || resp.status >= 300) {
      if (lastErr) throw lastErr;
      return resp as Response;
    }

    let streamBody: ReadableStream<Uint8Array> | null = resp.body;
    if (request.stream || actualStream) {
      const { retired, notice, body: peeked } = await peekRetiredNotice(resp);
      if (retired) return retiredResponse(notice);
      streamBody = peeked ?? resp.body;
    }
    if (!streamBody) throw new Error("antigravity response stream is empty");

    if (request.stream) {
      return new Response(geminiSseToOpenAiStream(this, streamBody, modelName, sessionId, toolSchemas), {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }
    if (actualStream) {
      const completion = await geminiStreamToOpenAiCompletionImpl(this, streamBody, modelName, sessionId, toolSchemas);
      return jsonResponse(200, completion);
    }
    const data = (await resp.json()) as unknown;
    const response = unwrapGeminiResponse(data);
    this.cacheSignaturesFromResponse(response, modelName, sessionId);
    return jsonResponse(200, geminiToOpenAiCompletion(response, modelName, toolSchemas));
  }
}
