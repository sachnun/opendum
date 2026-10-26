import { Effect, Result } from "effect";
import { Value, Payload, Ids, Responses, JSONText } from "@opendum/providers/core/helpers";
import { RequestFailure } from "@opendum/providers/core/http";
import { OAuth } from "@opendum/providers/core/oauth";
import { OAuthProvider, type Json, type ProviderOptions } from "@opendum/providers/core/provider";
import { Collector } from "@opendum/providers/transform/collector";
import type {
  ProviderAccount,
  ProviderFailure,
  ProviderRequest,
  RefreshedCredentials,
  ProviderCredentialFailure,
} from "@opendum/providers/types";

import { WORKBUDDY_BASE_URL, WORKBUDDY_DOMAIN } from "@opendum/providers/auth/workbuddy/constants";

const WORKBUDDY_API_BASE = WORKBUDDY_BASE_URL;
const WORKBUDDY_CHAT_PATH = "/v2/chat/completions";
const WORKBUDDY_REFRESH_PATH = "/v2/plugin/auth/token/refresh";
const WORKBUDDY_REFRESH_SOURCE = "plugin";
const WORKBUDDY_DEFAULT_SYSTEM = "You are a helpful assistant.";
const DEFAULT_MAX_TOKENS = 32768;
const FALLBACK_TTL = 31536000;
const WORKBUDDY_IDE_TYPE = "WorkBuddy";
const WORKBUDDY_IDE_NAME = "WorkBuddy";
const WORKBUDDY_IDE_VERSION = "5.8.4";
const WORKBUDDY_PRODUCT = "SaaS";
const WORKBUDDY_AGENT_INTENT = "craft";
const WORKBUDDY_AGENT_PURPOSE = "conversation";
const WORKBUDDY_AGENT_TYPE = "main";
const WORKBUDDY_AGENT_RUNTIME = "other";
const WORKBUDDY_CLI_VERSION = "2.161.0";
const WORKBUDDY_USER_AGENT = `WorkBuddy/${WORKBUDDY_IDE_VERSION} WorkBuddy/${WORKBUDDY_IDE_VERSION} CLI/${WORKBUDDY_CLI_VERSION}`;
const WORKBUDDY_SDK_HEADERS: Record<string, string> = {
  "x-stainless-lang": "js",
  "x-stainless-package-version": "6.25.0",
  "x-stainless-os": "Linux",
  "x-stainless-arch": "x64",
  "x-stainless-retry-count": "0",
  "x-stainless-runtime": "node",
  "x-stainless-runtime-version": "v22.22.3",
};

export const SUPPORTED_WORKBUDDY = new Set([
  "model", "messages", "temperature", "top_p", "max_tokens", "max_completion_tokens", "stream",
  "stream_options", "tools", "tool_choice", "parallel_tool_calls", "presence_penalty",
  "frequency_penalty", "n", "stop", "seed", "response_format", "reasoning", "reasoning_effort",
]);

function traceHeaders(): Record<string, string> {
  const traceId = Ids.hex(crypto.getRandomValues(new Uint8Array(16)));
  const spanId = Ids.hex(crypto.getRandomValues(new Uint8Array(8)));
  const parentSpanId = Ids.hex(crypto.getRandomValues(new Uint8Array(8)));
  return {
    traceparent: `00-${traceId}-${spanId}-01`,
    b3: `${traceId}-${spanId}-1-${parentSpanId}`,
    "X-B3-TraceId": traceId,
    "X-B3-ParentSpanId": parentSpanId,
    "X-B3-SpanId": spanId,
    "X-B3-Sampled": "1",
    "X-Trace-ID": traceId,
  };
}

function parseJson(text: string): unknown {
  return Value.parseJson(text);
}

function normalizeTools(value: unknown): unknown[] | null {
  let candidate = value;
  if (typeof candidate === "string") {
    const trimmed = candidate.trim();
    if (!trimmed) return null;
    candidate = parseJson(trimmed);
  }
  if (!Array.isArray(candidate)) return null;
  const tools = candidate.filter((tool) => tool !== null && typeof tool === "object" && !Array.isArray(tool));
  return tools.length > 0 ? tools : null;
}

function conversationSeed(uid: string, request: ProviderRequest, messages: unknown[]): string {
  const sessionId = Value.string(request.sessionId).trim();
  if (sessionId) return `${uid}:${sessionId}`;
  for (const raw of messages) {
    const message = (raw ?? {}) as Json;
    if (Value.string(message.role) !== "user") continue;
    const text = Payload.text(message.content).trim();
    if (text) return `${uid}:${text}`;
  }
  return "";
}

function workbuddyExpiry(expiresAt: number, expiresIn: number): Date {
  if (expiresAt > 0) {
    return expiresAt > 10_000_000_000 ? new Date(expiresAt) : new Date(expiresAt * 1000);
  }
  if (expiresIn > 0) return new Date(Date.now() + expiresIn * 1000);
  return new Date(Date.now() + FALLBACK_TTL * 1000);
}

export class WorkbuddyProvider extends OAuthProvider {
  readonly name = "workbuddy";
  protected readonly refreshBufferMs = 5 * 60 * 1000;
  private readonly oauth: OAuth;

  constructor(options: ProviderOptions) {
    super(options);
    this.oauth = new OAuth({
      provider: "workbuddy",
      tokenUrl: `${WORKBUDDY_API_BASE}${WORKBUDDY_REFRESH_PATH}`,
      transport: options.transport,
      request: (refreshToken) => ({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-Domain": WORKBUDDY_DOMAIN,
          "X-Refresh-Token": refreshToken.trim(),
          "X-Auth-Refresh-Source": WORKBUDDY_REFRESH_SOURCE,
        },
        body: "{}",
      }),
      parse: (payload, refreshToken) => {
        const parsed = payload as {
          code?: number;
          data?: { accessToken?: string; refreshToken?: string; expiresIn?: number; expiresAt?: number };
        };
        const accessToken = (parsed.data?.accessToken ?? "").trim();
        if (parsed.code !== 0 || !accessToken) {
          return Result.fail("workbuddy token refresh returned empty token");
        }
        return Result.succeed({
          accessToken,
          refreshToken: (parsed.data?.refreshToken ?? "").trim() || refreshToken.trim(),
          expiresAt: workbuddyExpiry(parsed.data?.expiresAt ?? 0, parsed.data?.expiresIn ?? 0),
        });
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
    const accountId = request.account.accountId;
    const uid = accountId ? accountId.trim() : "";
    if (!uid) {
      return Effect.fail(
        RequestFailure.transport("workbuddy", new Error("workbuddy account is missing user id, re-authenticate this account"))
      );
    }
    const payload: Json = this.filterParams(request.body, SUPPORTED_WORKBUDDY, ["tools", "tool_choice"]);
    const tools = normalizeTools(request.body.tools);
    if (tools) {
      payload.tools = tools;
      const toolChoice = request.body.tool_choice;
      if (toolChoice !== undefined && toolChoice !== null) payload.tool_choice = toolChoice;
    }
    const modelName = this.upstream(Value.string(request.body.model));
    const messages = Array.isArray(request.body.messages) ? request.body.messages : [];
    const normalizedMessages = ensureSystem(messages);
    payload.messages = normalizedMessages;
    let maxTokens = Value.number(request.body.max_tokens);
    if (maxTokens <= 0) maxTokens = Value.number(request.body.max_completion_tokens);
    if (maxTokens <= 0) maxTokens = DEFAULT_MAX_TOKENS;
    payload.max_tokens = maxTokens;
    payload.max_completion_tokens = maxTokens;
    payload.model = modelName;
    payload.stream = true;

    const seed = conversationSeed(uid, request, normalizedMessages);
    const conversationId = seed ? Ids.seeded(seed) : Ids.uuidV7();
    const conversationRequestId = Value.string(request.requestId).trim() || Ids.uuidV7();
    const messageId = Ids.uuidV7();
    const acpConnectionId = seed ? Ids.seeded(`${seed}:acp`) : Ids.uuidV7();
    const sessionTag = conversationId;

    const url = `${WORKBUDDY_API_BASE}${WORKBUDDY_CHAT_PATH}`;
    const direct = this.transport.direct;
    return RequestFailure.normalize(
      "workbuddy",
      Effect.gen(function* () {
        const resp = yield* Effect.tryPromise({
          try: () =>
            direct(url, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${request.credentials.trim()}`,
                "X-User-Id": uid,
                "X-Domain": WORKBUDDY_DOMAIN,
                "X-Conversation-ID": conversationId,
                "X-Conversation-Request-ID": conversationRequestId,
                "X-Conversation-Message-ID": messageId,
                "X-Root-Request-ID": conversationRequestId,
                "X-Request-ID": messageId,
                "acp-connection-id": acpConnectionId,
                "baggage": `codebuddy.session_id=${sessionTag},codebuddy.conversation_request_id=${conversationRequestId}`,
                "X-Agent-Intent": WORKBUDDY_AGENT_INTENT,
                "X-Agent-Purpose": WORKBUDDY_AGENT_PURPOSE,
                "X-Agent-Type": WORKBUDDY_AGENT_TYPE,
                "X-Agent-Runtime": WORKBUDDY_AGENT_RUNTIME,
                ...WORKBUDDY_SDK_HEADERS,
                "X-IDE-Type": WORKBUDDY_IDE_TYPE,
                "X-IDE-Name": WORKBUDDY_IDE_NAME,
                "X-IDE-Version": WORKBUDDY_IDE_VERSION,
                "X-Product": WORKBUDDY_PRODUCT,
                "X-Private-Data": "true",
                "x-requested-with": "XMLHttpRequest",
                "x-codebuddy-request": "1",
                "User-Agent": WORKBUDDY_USER_AGENT,
                "Content-Type": "application/json",
                Accept: "text/event-stream",
                ...traceHeaders(),
              },
              body: JSON.stringify(payload),
            }),
          catch: (cause) => RequestFailure.transport("workbuddy", cause, url),
        });
        if (resp.status < 200 || resp.status >= 300) return resp;
        request.onResponseStart?.();
        if (request.stream) return resp;
        const body = yield* Effect.promise(() => resp.text());
        return Responses.json(200, fromStream(body, modelName));
      })
    );
  }
}

function channelText(text: string): string {
  if (!text) return text;
  let out = text;
  if (out.includes("Anthropic's official CLI for Claude")) {
    out = out.replaceAll("Anthropic's official CLI for Claude", "Anthropic official CLI for Claude");
  }
  if (out.includes("Main branch") && out.includes("for PRs")) {
    out = out.replaceAll(" (you will usually use this for PRs)", "");
  }
  return out;
}

function sanitizeContent(content: unknown): unknown {
  if (typeof content === "string") return channelText(content);
  if (Array.isArray(content)) return content.map(sanitizeContent);
  if (content !== null && typeof content === "object") {
    const record = content as Json;
    const next: Json = { ...record };
    if (typeof record.text === "string") next.text = channelText(record.text);
    if (record.content !== undefined) next.content = sanitizeContent(record.content);
    return next;
  }
  return content;
}

function ensureSystem(messages: unknown[]): unknown[] {
  const normalized: unknown[] = [];
  for (const raw of messages) {
    const msg = raw as Json;
    if (msg && Value.string(msg.role) === "developer") {
      normalized.push({ ...msg, role: "system", content: sanitizeContent(msg.content) });
      continue;
    }
    if (msg && Value.string(msg.role) === "system") {
      normalized.push({ ...msg, content: sanitizeContent(msg.content) });
      continue;
    }
    normalized.push(raw);
  }
  const first = normalized[0] as Json | undefined;
  if (first && Value.string(first.role) === "system") return normalized;
  return [{ role: "system", content: WORKBUDDY_DEFAULT_SYSTEM }, ...normalized];
}

function deltaText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    let out = "";
    for (const part of value) {
      const m = part as Json;
      const text = Value.string(m?.text) || Value.string(m?.content);
      if (text) out += text;
    }
    return out;
  }
  return "";
}

export function fromStream(text: string, model: string): Json {
  const collector = new Collector({ model, id: "chatcmpl-workbuddy" });
  for (const event of JSONText.sseLines(text)) {
    const nextUsage = event.usage;
    if (nextUsage !== null && typeof nextUsage === "object" && Object.keys(nextUsage as Json).length > 0) {
      collector.setUsage(nextUsage as Json);
    }
    const choices = Array.isArray(event.choices) ? event.choices : [];
    if (choices.length === 0) continue;
    const choice = (choices[0] ?? {}) as Json;
    collector.setFinish(Value.string(choice.finish_reason));
    const delta = choice.delta;
    if (delta === null || typeof delta !== "object") continue;
    const d = delta as Json;
    collector.addContent(deltaText(d.content));
    if (typeof d.reasoning_content === "string") collector.addContent(d.reasoning_content);
    const fragments = Array.isArray(d.tool_calls) ? d.tool_calls : [];
    for (const raw of fragments) {
      const fragment = (raw ?? {}) as Json;
      const fn = fragment.function;
      const hasFunction = fn !== null && typeof fn === "object" && !Array.isArray(fn);
      const args = hasFunction ? (fn as Json).arguments : undefined;
      collector.addToolCall({
        key: Value.number(fragment.index),
        id: Value.string(fragment.id),
        type: Value.string(fragment.type),
        name: hasFunction ? Value.string((fn as Json).name) : "",
        nameMode: "append",
        arguments: typeof args === "string" ? args : "",
      });
    }
  }
  return collector.toCompletion();
}
