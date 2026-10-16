import { Effect } from "effect";
import type { Registry } from "@opendum/models/runtime";
import { jsonResponse, randomId, stringValue } from "../../core/helpers.js";
import { normalizeProviderFailure, transportFailure, type UpstreamTransport } from "../../core/http.js";
import { ProviderCredentialFailure } from "../../core/errors.js";
import { OAuth } from "../../core/oauth.js";
import { KIRO_REFRESH_ENDPOINT } from "../../endpoints.js";
import {
  Parser,
  buildKiroRequest,
  convertKiroEventsToCompletion,
  kiroApiUrlForAccount,
  kiroErrorMessage,
  kiroNumberAsFloat,
  kiroReasoningContent,
  kiroUsage,
  kiroUsageFromContext,
  lastModelSegment,
  normalizeKiroTier,
  parseKiroBracketToolCalls,
  type Json,
} from "./transform.js";
import type {
  CredentialRefresher,
  Provider,
  ProviderAccount,
  ProviderFailure,
  ProviderRequest,
  RefreshedCredentials,
  RefreshBufferProvider,
} from "../../types.js";

export type KiroOptions = {
  registry: Registry;
  transport: UpstreamTransport;
};

export class KiroProvider implements Provider, CredentialRefresher, RefreshBufferProvider {
  readonly name = "kiro";
  private readonly registry: Registry;
  private readonly transport: UpstreamTransport;
  private readonly exchange: OAuth;

  constructor(options: KiroOptions) {
    this.registry = options.registry;
    this.transport = options.transport;
    this.exchange = new OAuth({
      provider: "kiro",
      tokenUrl: KIRO_REFRESH_ENDPOINT,
      transport: options.transport,
      request: (refreshToken) => ({
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "KiroIDE" },
        body: JSON.stringify({ refreshToken: refreshToken.trim() }),
      }),
      parse: async (payload, refreshToken) => {
        const token = payload as { accessToken?: string; refreshToken?: string; expiresIn?: number };
        const accessToken = (token.accessToken ?? "").trim();
        if (!accessToken) throw new Error("kiro token refresh returned empty access token");
        const nextRefresh = token.refreshToken || refreshToken;
        const expiresIn = token.expiresIn && token.expiresIn > 0 ? token.expiresIn : 3600;
        const tier = await this.fetchSubscriptionTier(accessToken);
        return { accessToken, refreshToken: nextRefresh, expiresAt: new Date(Date.now() + expiresIn * 1000), tier };
      },
    });
  }

  refreshBuffer(): number {
    return 5 * 60 * 1000;
  }

  refreshCredentials(
    refreshToken: string,
    account: ProviderAccount
  ): Effect.Effect<RefreshedCredentials, ProviderCredentialFailure> {
    return this.exchange.exchange(refreshToken, account);
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
          "User-Agent": "KiroIDE-1.3.11",
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

  makeRequest(request: ProviderRequest): Effect.Effect<Response, ProviderFailure> {
    const body = request.body;
    const modelName = lastModelSegment(stringValue(body.model));
    const payload = buildKiroRequest(this.registry, body);
    const accountId = request.account.accountId?.trim();
    if (accountId) payload.profileArn = accountId;
    const transport = this.transport;
    const url = kiroApiUrlForAccount(request.account);

    return normalizeProviderFailure(
      "kiro",
      Effect.gen(function* () {
        const resp = yield* Effect.tryPromise({
          try: () =>
            transport.direct(url, {
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
            }),
          catch: (cause) => transportFailure("kiro", cause, url),
        });
        if (resp.status < 200 || resp.status >= 300) return resp;
        request.onUpstreamResponseStart?.();
        if (!resp.body) {
          return jsonResponse(502, { error: { message: "Kiro response stream is empty", type: "api_error" } });
        }

        if (request.stream) {
          return new Response(kiroSseStream(resp.body, modelName), {
            status: 200,
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            },
          });
        }
        const rawText = yield* Effect.promise(() => resp.text());
        const events = new Parser().feed(rawText);
        return jsonResponse(200, convertKiroEventsToCompletion(events, modelName));
      })
    );
  }
}

async function* transformKiroSse(source: ReadableStream<Uint8Array>, model: string): AsyncGenerator<string> {
  const parser = new Parser();
  const completionId = randomId("chatcmpl");
  let sentRole = false;
  let toolCallCount = 0;
  let activeToolId = "";
  const toolIndex = new Map<string, number>();
  let hasNativeReasoning = false;
  let totalContent = "";
  let outputText = "";
  let contextUsagePercentage = 0;
  let explicitUsage: Json | null = null;
  const pending: string[] = [];

  const writeChunk = (delta: Json, finish: unknown, usage: Json | null): void => {
    const chunk: Json = {
      id: completionId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    };
    if (usage) chunk.usage = usage;
    pending.push(`data: ${JSON.stringify(chunk)}\n\n`);
  };
  const ensureRole = (): void => {
    if (sentRole) return;
    writeChunk({ role: "assistant", content: "" }, null, null);
    sentRole = true;
  };
  const emitContent = (contentDelta: string, reasoningDelta: string): void => {
    if (reasoningDelta) {
      ensureRole();
      outputText += reasoningDelta;
      writeChunk({ reasoning_content: reasoningDelta }, null, null);
    }
    if (contentDelta) {
      ensureRole();
      outputText += contentDelta;
      writeChunk({ content: contentDelta }, null, null);
    }
  };

  const processEvent = (event: Json): void => {
    if (event.contextUsagePercentage !== undefined) {
      contextUsagePercentage = kiroNumberAsFloat(event.contextUsagePercentage);
      return;
    }
    const usage = kiroUsage(event);
    if (usage) {
      explicitUsage = usage;
      return;
    }
    if (kiroErrorMessage(event)) return;
    const reasoning = kiroReasoningContent(event);
    if (reasoning) {
      hasNativeReasoning = true;
      emitContent("", reasoning);
      return;
    }
    if (typeof event.content === "string" && event.followupPrompt === undefined) {
      totalContent += event.content;
      let [contentDelta, reasoningDelta] = parser.processContent(event.content, false);
      if (hasNativeReasoning && reasoningDelta) reasoningDelta = "";
      emitContent(contentDelta, reasoningDelta);
      void contentDelta;
    }
    const name = stringValue(event.name);
    if (name && stringValue(event.toolUseId)) {
      ensureRole();
      const id = stringValue(event.toolUseId);
      let idx = toolIndex.get(id);
      if (idx === undefined) {
        idx = toolCallCount;
        toolIndex.set(id, idx);
        toolCallCount += 1;
      }
      activeToolId = id;
      writeChunk(
        { tool_calls: [{ index: idx, id, type: "function", function: { name, arguments: "" } }] },
        null,
        null
      );
      const input = stringValue(event.input);
      if (input) {
        writeChunk({ tool_calls: [{ index: idx, function: { arguments: input } }] }, null, null);
      }
    }
    const input = stringValue(event.input);
    if (input && !stringValue(event.name) && activeToolId) {
      const idx = toolIndex.get(activeToolId);
      if (idx !== undefined) {
        ensureRole();
        writeChunk({ tool_calls: [{ index: idx, function: { arguments: input } }] }, null, null);
      }
    }
    if (event.stop === true) activeToolId = "";
  };

  const reader = source.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      for (const event of parser.feed(text)) processEvent(event);
      for (const chunk of pending.splice(0)) yield chunk;
    }
    const tail = decoder.decode();
    if (tail) {
      for (const event of parser.feed(tail)) processEvent(event);
    }
    for (const event of parser.finish()) processEvent(event);
  } finally {
    reader.releaseLock();
  }

  let [flushContent, flushReasoning] = parser.flushContent();
  if (hasNativeReasoning) flushReasoning = "";
  emitContent(flushContent, flushReasoning);
  for (const call of parseKiroBracketToolCalls(totalContent)) {
    const idx = toolCallCount;
    toolCallCount += 1;
    writeChunk(
      { tool_calls: [{ index: idx, id: call.id, type: "function", function: { name: call.name, arguments: "" } }] },
      null,
      null
    );
    writeChunk(
      { tool_calls: [{ index: idx, function: { arguments: call.arguments } }] },
      null,
      null
    );
  }
  const finish = toolCallCount > 0 ? "tool_calls" : "stop";
  const usage = explicitUsage ?? kiroUsageFromContext(model, contextUsagePercentage, outputText);
  writeChunk({}, finish, usage);
  pending.push("data: [DONE]\n\n");
  for (const chunk of pending.splice(0)) yield chunk;
  void flushContent;
  void flushReasoning;
}

function kiroSseStream(source: ReadableStream<Uint8Array>, model: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const iterator = transformKiroSse(source, model)[Symbol.asyncIterator]();
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

export { Parser, normalizeKiroTier, convertKiroEventsToCompletion };
