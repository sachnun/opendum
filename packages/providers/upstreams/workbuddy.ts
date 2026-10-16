import { Effect } from "effect";
import type { Registry } from "@opendum/models/runtime";
import { jsonResponse, numberFromAny, parseSseDataLines, stringValue } from "../core/helpers.js";
import { normalizeProviderFailure, transportFailure, type UpstreamTransport } from "../core/http.js";
import { ProviderCredentialFailure } from "../core/errors.js";
import { OAuth } from "../core/oauth.js";
import { Collector } from "../transform/collector.js";
import type {
  CredentialRefresher,
  Provider,
  ProviderAccount,
  ProviderFailure,
  ProviderRequest,
  RefreshedCredentials,
} from "../types.js";

import { WORKBUDDY_BASE_URL, WORKBUDDY_DOMAIN } from "../endpoints.js";

const WORKBUDDY_API_BASE = WORKBUDDY_BASE_URL;
const WORKBUDDY_CHAT_PATH = "/v2/chat/completions";
const WORKBUDDY_REFRESH_PATH = "/v2/plugin/auth/token/refresh";
const WORKBUDDY_REFRESH_SOURCE = "plugin";
const WORKBUDDY_DEFAULT_SYSTEM = "You are a helpful assistant.";
const WORKBUDDY_DEFAULT_MAX_TOKENS = 32768;
const WORKBUDDY_FALLBACK_TTL_SECONDS = 31536000;

export const SUPPORTED_WORKBUDDY = new Set([
  "model", "messages", "temperature", "top_p", "max_tokens", "max_completion_tokens", "stream",
  "stream_options", "tools", "tool_choice", "parallel_tool_calls", "presence_penalty",
  "frequency_penalty", "n", "stop", "seed", "response_format", "reasoning", "reasoning_effort",
]);

type Json = Record<string, unknown>;

function lastModelSegment(model: string): string {
  const parts = model.split("/");
  return parts[parts.length - 1];
}

function workbuddyExpiry(expiresAt: number, expiresIn: number): Date {
  if (expiresAt > 0) {
    return expiresAt > 10_000_000_000 ? new Date(expiresAt) : new Date(expiresAt * 1000);
  }
  if (expiresIn > 0) return new Date(Date.now() + expiresIn * 1000);
  return new Date(Date.now() + WORKBUDDY_FALLBACK_TTL_SECONDS * 1000);
}

export type WorkbuddyOptions = {
  registry: Registry;
  transport: UpstreamTransport;
};

export class WorkbuddyProvider implements Provider, CredentialRefresher {
  readonly name = "workbuddy";
  private readonly registry: Registry;
  private readonly transport: UpstreamTransport;
  private readonly exchange: OAuth;

  constructor(options: WorkbuddyOptions) {
    this.registry = options.registry;
    this.transport = options.transport;
    this.exchange = new OAuth({
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
          throw new Error("workbuddy token refresh returned empty token");
        }
        return {
          accessToken,
          refreshToken: (parsed.data?.refreshToken ?? "").trim() || refreshToken.trim(),
          expiresAt: workbuddyExpiry(parsed.data?.expiresAt ?? 0, parsed.data?.expiresIn ?? 0),
        };
      },
    });
  }

  refreshCredentials(
    refreshToken: string,
    account: ProviderAccount
  ): Effect.Effect<RefreshedCredentials, ProviderCredentialFailure> {
    return this.exchange.exchange(refreshToken, account);
  }

  makeRequest(request: ProviderRequest): Effect.Effect<Response, ProviderFailure> {
    const accountId = request.account.accountId;
    const uid = accountId ? accountId.trim() : "";
    if (!uid) {
      return Effect.fail(
        transportFailure("workbuddy", new Error("workbuddy account is missing user id, re-authenticate this account"))
      );
    }
    const payload: Json = {};
    for (const [key, value] of Object.entries(request.body)) {
      if (SUPPORTED_WORKBUDDY.has(key) && value !== undefined && value !== null) payload[key] = value;
    }
    let model = stringValue(request.body.model);
    if (model.startsWith("workbuddy/")) model = model.slice("workbuddy/".length);
    let modelName = lastModelSegment(model);
    modelName = this.registry.upstream(modelName, "workbuddy") || model;
    const messages = Array.isArray(request.body.messages) ? request.body.messages : [];
    payload.messages = ensureSystemMessage(messages);
    let maxTokens = numberFromAny(request.body.max_tokens);
    if (maxTokens <= 0) maxTokens = numberFromAny(request.body.max_completion_tokens);
    if (maxTokens <= 0) maxTokens = WORKBUDDY_DEFAULT_MAX_TOKENS;
    payload.max_tokens = maxTokens;
    payload.max_completion_tokens = maxTokens;
    payload.model = modelName;
    payload.stream = true;

    const url = `${WORKBUDDY_API_BASE}${WORKBUDDY_CHAT_PATH}`;
    const direct = this.transport.direct;
    return normalizeProviderFailure(
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
                "Content-Type": "application/json",
                Accept: "text/event-stream",
              },
              body: JSON.stringify(payload),
            }),
          catch: (cause) => transportFailure("workbuddy", cause, url),
        });
        if (resp.status < 200 || resp.status >= 300) return resp;
        request.onUpstreamResponseStart?.();
        if (request.stream) return resp;
        const body = yield* Effect.promise(() => resp.text());
        return jsonResponse(200, workbuddyStreamToCompletion(body, modelName));
      })
    );
  }
}

function ensureSystemMessage(messages: unknown[]): unknown[] {
  const normalized: unknown[] = [];
  for (const raw of messages) {
    const msg = raw as Json;
    if (msg && stringValue(msg.role) === "developer") {
      normalized.push({ ...msg, role: "system" });
      continue;
    }
    normalized.push(raw);
  }
  const first = normalized[0] as Json | undefined;
  if (first && stringValue(first.role) === "system") return normalized;
  return [{ role: "system", content: WORKBUDDY_DEFAULT_SYSTEM }, ...normalized];
}

function workbuddyDeltaText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    let out = "";
    for (const part of value) {
      const m = part as Json;
      const text = stringValue(m?.text) || stringValue(m?.content);
      if (text) out += text;
    }
    return out;
  }
  return "";
}

export function workbuddyStreamToCompletion(text: string, model: string): Json {
  const collector = new Collector({ model, id: "chatcmpl-workbuddy" });
  for (const event of parseSseDataLines(text)) {
    const nextUsage = event.usage;
    if (nextUsage !== null && typeof nextUsage === "object" && Object.keys(nextUsage as Json).length > 0) {
      collector.setUsage(nextUsage as Json);
    }
    const choices = Array.isArray(event.choices) ? event.choices : [];
    if (choices.length === 0) continue;
    const choice = (choices[0] ?? {}) as Json;
    collector.setFinishReason(stringValue(choice.finish_reason));
    const delta = choice.delta;
    if (delta === null || typeof delta !== "object") continue;
    const d = delta as Json;
    collector.addContent(workbuddyDeltaText(d.content));
    if (typeof d.reasoning_content === "string") collector.addContent(d.reasoning_content);
    const fragments = Array.isArray(d.tool_calls) ? d.tool_calls : [];
    for (const raw of fragments) {
      const fragment = (raw ?? {}) as Json;
      const fn = fragment.function;
      const hasFunction = fn !== null && typeof fn === "object" && !Array.isArray(fn);
      const args = hasFunction ? (fn as Json).arguments : undefined;
      collector.addToolCall({
        key: numberFromAny(fragment.index),
        id: stringValue(fragment.id),
        type: stringValue(fragment.type),
        name: hasFunction ? stringValue((fn as Json).name) : "",
        nameMode: "append",
        arguments: typeof args === "string" ? args : "",
      });
    }
  }
  return collector.toCompletion();
}
