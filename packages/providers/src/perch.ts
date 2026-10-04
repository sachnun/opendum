import { randomBytes } from "node:crypto";
import type { Registry } from "@opendum/models/runtime";
import {
  boolFromAny,
  defaultStringValue,
  jsonResponse,
  numberFromAny,
  randomId,
  stringValue,
} from "./helpers.js";
import type { UpstreamTransport } from "./http.js";
import type {
  CredentialRefresher,
  Provider,
  ProviderAccount,
  ProviderRequest,
  RefreshedCredentials,
  RefreshBufferProvider,
} from "./types.js";

const PERCH_APP_URL = "https://app.perchai.app";
const PERCH_AUTH_CONFIG_PATH = "/api/perch-terminal/cli-auth/config";
const PERCH_ACCOUNT_PATH = "/api/perchai/account";
const PERCH_TURN_TICKET_PATH = "/api/perch-terminal/turn-ticket";
const PERCH_TURN_TICKET_HEADER = "x-perch-turn-ticket";
const PERCH_CLI_VERSION = "2.4.98";
const PERCH_MODEL_CALL_PATH = "/api/perch-terminal/model-call";
const PERCH_ACCESS_TTL_MS = 60 * 60 * 1000;
const PERCH_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const PERCH_CONFIG_CACHE_TTL_MS = 15 * 60 * 1000;
const PERCH_SESSION_CACHE_TTL_MS = 10 * 60 * 1000;
const PERCH_FALLBACK_ALIAS = "qwen-3.6";
const PERCH_CALL_TIMEOUT_MS = 5000;

const PERCH_MANUAL_OPTION_IDS: Record<string, string> = {
  "qwen-3.6": "wandb-qwen3-6-35b-a3b",
  "kimi-2.5": "bedrock-mantle-moonshotai-kimi-k2-5",
  "glm-5": "bedrock-mantle-zai-glm-5",
  "qwen3-coder": "bedrock-mantle-qwen-qwen3-coder-480b-a35b-instruct",
  "nemotron-super": "bedrock-mantle-nvidia-nemotron-super-3-120b",
  "gemma-4-e2b": "bedrock-mantle-google-gemma-4-e2b",
  "gemma-4-31b": "bedrock-mantle-google-gemma-4-31b",
};

type Json = Record<string, unknown>;

type PerchAuthConfig = { supabaseUrl: string; anonKey: string };

let authConfigCache: { config: PerchAuthConfig; fetchedAt: number } | null = null;
const sessionCache = new Map<string, { ids: PerchSessionIds; fetchedAt: number }>();

type PerchSessionIds = { userId: string; workspaceId: string };

export class PerchUpstreamError extends Error {
  readonly quota: boolean;
  constructor(message: string, quota: boolean) {
    super(message);
    this.name = "PerchUpstreamError";
    this.quota = quota;
  }
}

async function fetchPerchAuthConfig(transport: UpstreamTransport): Promise<PerchAuthConfig> {
  if (authConfigCache && Date.now() - authConfigCache.fetchedAt < PERCH_CONFIG_CACHE_TTL_MS) {
    return authConfigCache.config;
  }
  const resp = await transport.direct(`${PERCH_APP_URL}${PERCH_AUTH_CONFIG_PATH}`, {
    headers: { Accept: "application/json" },
  });
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`perch auth config request failed: ${resp.status}`);
  }
  const payload = (await resp.json()) as { supabaseUrl?: string; supabaseAnonKey?: string };
  const supabaseUrl = (payload.supabaseUrl ?? "").trim();
  const anonKey = (payload.supabaseAnonKey ?? "").trim();
  if (!supabaseUrl || !anonKey) throw new Error("perch auth config is incomplete");
  const config = { supabaseUrl: supabaseUrl.replace(/\/+$/, ""), anonKey };
  authConfigCache = { config, fetchedAt: Date.now() };
  return config;
}

function perchTokenHeaders(config: PerchAuthConfig): Record<string, string> {
  return {
    "Content-Type": "application/json",
    apikey: config.anonKey,
    Authorization: `Bearer ${config.anonKey}`,
  };
}

function perchUserAgent(): string {
  return `perchai-cli/${PERCH_CLI_VERSION}`;
}

function perchRunId(): string {
  return `cli-turn-${Date.now()}-${randomBytes(4).toString("hex")}`;
}

async function sessionIdsForAccount(
  transport: UpstreamTransport,
  account: ProviderAccount,
  accessToken: string
): Promise<PerchSessionIds | null> {
  if (!account.id) return null;
  const cached = sessionCache.get(account.id);
  if (cached && Date.now() - cached.fetchedAt < PERCH_SESSION_CACHE_TTL_MS) return cached.ids;
  try {
    const resp = await transport.direct(`${PERCH_APP_URL}${PERCH_ACCOUNT_PATH}`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${accessToken.trim()}` },
      signal: AbortSignal.timeout(PERCH_CALL_TIMEOUT_MS),
    });
    if (resp.status < 200 || resp.status >= 300) return null;
    const payload = (await resp.json()) as {
      ok?: boolean;
      session?: { userId?: string; workspaceId?: string };
    };
    if (!payload.ok) return null;
    const ids = {
      userId: payload.session?.userId ?? "",
      workspaceId: payload.session?.workspaceId ?? "",
    };
    sessionCache.set(account.id, { ids, fetchedAt: Date.now() });
    return ids;
  } catch {
    return null;
  }
}

async function perchTurnTicket(
  transport: UpstreamTransport,
  accessToken: string
): Promise<{ ticket: string; runId: string }> {
  const resp = await transport.direct(`${PERCH_APP_URL}${PERCH_TURN_TICKET_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${accessToken.trim()}`,
      "User-Agent": perchUserAgent(),
    },
    body: JSON.stringify({ surface: "cli", profile: "standard" }),
  });
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`perch turn ticket failed: ${resp.status} ${(await resp.text()).slice(0, 1024)}`);
  }
  const result = (await resp.json()) as {
    ok?: boolean;
    ticket?: string;
    runId?: string;
    error?: string;
  };
  if (result.ok === false) {
    throw new Error((result.error ?? "").trim() || "Perch turn ticket request failed");
  }
  const ticket = (result.ticket ?? "").trim();
  const runId = (result.runId ?? "").trim();
  if (!ticket || !runId) {
    throw new Error((result.error ?? "").trim() || "Perch turn ticket returned incomplete credentials");
  }
  return { ticket, runId };
}

function perchTextFromContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const part of value) {
      const map = (part ?? {}) as Json;
      if (stringValue(map.type) === "text") {
        const text = stringValue(map.text);
        if (text) parts.push(text);
      }
    }
    return parts.join("\n");
  }
  return "";
}

function perchMessages(body: Json): unknown[] {
  const out: unknown[] = [];
  const system = perchTextFromContent(body.system).trim();
  if (system) out.push({ role: "system", content: system });
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  for (const raw of rawMessages) {
    const message = (raw ?? {}) as Json;
    switch (stringValue(message.role)) {
      case "system":
      case "developer": {
        const text = perchTextFromContent(message.content).trim();
        if (text) out.push({ role: "system", content: text });
        break;
      }
      case "user":
        out.push({ role: "user", content: perchTextFromContent(message.content) });
        break;
      case "assistant": {
        const entry: Json = { role: "assistant", content: perchTextFromContent(message.content) };
        const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
        if (calls.length > 0) {
          entry.tool_calls = calls.map((rawCall) => {
            const call = (rawCall ?? {}) as Json;
            const fn = (call.function ?? {}) as Json;
            return {
              id: stringValue(call.id),
              type: "function",
              function: {
                name: stringValue(fn.name),
                arguments: stringValue(fn.arguments) || "{}",
              },
            };
          });
        }
        out.push(entry);
        break;
      }
      case "tool":
        out.push({
          role: "tool",
          tool_call_id: stringValue(message.tool_call_id),
          content: perchTextFromContent(message.content),
        });
        break;
      default:
        break;
    }
  }
  return out;
}

function perchTools(body: Json): unknown[] | null {
  const rawTools = Array.isArray(body.tools) ? body.tools : [];
  if (rawTools.length === 0) return null;
  const out: Json[] = [];
  for (const raw of rawTools) {
    const tool = (raw ?? {}) as Json;
    const fn = (tool.function ?? {}) as Json;
    const name = stringValue(fn.name);
    if (!name) continue;
    const parameters = fn.parameters ?? { type: "object", properties: {} };
    const convertedFn: Json = { name, parameters };
    const description = stringValue(fn.description);
    if (description) convertedFn.description = description;
    out.push({ type: "function", function: convertedFn });
  }
  return out.length > 0 ? out : null;
}

function perchEffortFromBody(body: Json): { level: string; reasoningEnabled: boolean } {
  let level = "high";
  let reasoningEnabled = true;
  const raw = body.reasoning_effort;
  if (typeof raw === "string") {
    switch (raw.trim().toLowerCase()) {
      case "off":
      case "none":
        level = "off";
        reasoningEnabled = false;
        break;
      case "low":
      case "medium":
        level = raw.trim().toLowerCase();
        break;
      default:
        level = "high";
    }
  }
  return { level, reasoningEnabled };
}

function perchModelAlias(registry: Registry, model: string): string {
  let value = model.trim();
  if (value.startsWith("perch/")) value = value.slice("perch/".length);
  value = registry.upstreamModelName(value, "perch");
  return value || PERCH_FALLBACK_ALIAS;
}

function perchSupportedModels(registry: Registry): string {
  return registry.modelsForProvider("perch").sort((a, b) => a.localeCompare(b)).join(", ");
}

function firstNonNil(...values: unknown[]): unknown {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return null;
}

function perchUsageToChatUsage(raw: unknown): Json | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const usage = raw as Json;
  const int = (key: string): number => {
    const value = usage[key];
    return typeof value === "number" && value > 0 ? Math.trunc(value) : 0;
  };
  const input = int("inputTokens");
  const output = int("outputTokens");
  const cacheRead = int("cacheReadInputTokens");
  if (input === 0 && output === 0 && cacheRead === 0) return null;
  const promptTokens = input + cacheRead;
  const out: Json = {
    prompt_tokens: promptTokens,
    completion_tokens: output,
    total_tokens: promptTokens + output,
  };
  if (cacheRead > 0) out.prompt_tokens_details = { cached_tokens: cacheRead };
  return out;
}

function perchErrorMessage(event: Json): string {
  const text = stringValue(event.error);
  if (text) return text;
  if (event.error !== undefined && event.error !== null) return JSON.stringify(event.error);
  return "";
}

function perchQuotaError(message: string): boolean {
  const lower = message.toLowerCase();
  return ["allowance", "quota", "limit", "usage", "billing", "credit"].some((marker) =>
    lower.includes(marker)
  );
}

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

function perchEventToolCalls(event: Json): unknown[] {
  if (Array.isArray(event.toolCalls)) return event.toolCalls;
  if (Array.isArray(event.tool_calls)) return event.tool_calls;
  return [];
}

function perchToolSealedArguments(call: Json): string {
  const text = stringValue(call.arguments);
  if (text) return text;
  if (call.arguments !== undefined && call.arguments !== null) return JSON.stringify(call.arguments);
  return "";
}

function perchToolArgumentsDelta(call: Json, sealed: boolean): string {
  const raw = stringValue(call.rawArgumentsText);
  if (raw) return raw;
  if (sealed) return perchToolSealedArguments(call);
  return "";
}

function perchWriteChunk(
  out: string[],
  completionId: string,
  model: string,
  delta: Json,
  finish: unknown,
  usage?: Json | null
): void {
  const chunk: Json = {
    id: completionId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
  if (usage) chunk.usage = usage;
  out.push(`data: ${JSON.stringify(chunk)}\n\n`);
}

function perchToolDeltaChunk(
  out: string[],
  completionId: string,
  model: string,
  index: number,
  withId: boolean,
  id: string,
  withName: boolean,
  name: string,
  args: string
): void {
  const toolDelta: Json = { index };
  const fn: Json = {};
  if (withId) {
    toolDelta.id = id;
    toolDelta.type = "function";
  }
  if (withName) fn.name = name;
  if (args) fn.arguments = args;
  toolDelta.function = fn;
  perchWriteChunk(out, completionId, model, { tool_calls: [toolDelta] }, null);
}

async function* transformPerchSseToChat(
  source: ReadableStream<Uint8Array>,
  model: string,
  includeReasoning: boolean
): AsyncGenerator<string> {
  const completionId = randomId("chatcmpl");
  let sentRole = false;
  let nextToolIndex = 0;
  const tools = new Map<string, { index: number; name: string; emittedArgs: boolean }>();
  let doneFlag = false;

  const ensureRole = (out: string[]): void => {
    if (sentRole) return;
    sentRole = true;
    perchWriteChunk(out, completionId, model, { role: "assistant", content: "" }, null);
  };

  const reader = source.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const out = handleLine(line);
        for (const chunk of out) yield chunk;
        if (doneFlag) return;
      }
    }
    buffer += decoder.decode();
    for (const line of buffer.split("\n")) {
      const out = handleLine(line);
      for (const chunk of out) yield chunk;
      if (doneFlag) return;
    }
  } finally {
    reader.releaseLock();
  }
  const out: string[] = [];
  perchWriteChunk(out, completionId, model, {}, "stop", null);
  out.push("data: [DONE]\n\n");
  for (const chunk of out) yield chunk;

  function handleLine(line: string): string[] {
    const out: string[] = [];
    const trimmed = line.trim();
    if (!trimmed || trimmed === "[DONE]" || trimmed.startsWith(":")) return out;
    const payload = trimmed.startsWith("data:") ? trimmed.slice("data:".length).trim() : trimmed;
    if (!payload || payload === "[DONE]") return out;
    let event: Json;
    try {
      event = JSON.parse(payload) as Json;
    } catch {
      return out;
    }
    switch (stringValue(event.type)) {
      case "reasoning_delta": {
        if (!includeReasoning) break;
        ensureRole(out);
        const delta = stringValue(event.text);
        if (delta) perchWriteChunk(out, completionId, model, { reasoning_content: delta }, null);
        break;
      }
      case "answer_delta": {
        ensureRole(out);
        const delta = stringValue(event.text);
        if (delta) perchWriteChunk(out, completionId, model, { content: delta }, null);
        break;
      }
      case "tool_call_delta":
      case "tool_use_end": {
        const sealed = stringValue(event.type) === "tool_use_end";
        for (const rawCall of perchEventToolCalls(event)) {
          const call = (rawCall ?? {}) as Json;
          const id = stringValue(call.id);
          if (!id) continue;
          let state = tools.get(id);
          if (!state) {
            ensureRole(out);
            const name = stringValue(call.name);
            state = { index: nextToolIndex, name, emittedArgs: false };
            tools.set(id, state);
            nextToolIndex += 1;
            perchToolDeltaChunk(out, completionId, model, state.index, true, id, name !== "", name, "");
          }
          const name = stringValue(call.name);
          if (name && !state.name) {
            state.name = name;
            perchToolDeltaChunk(out, completionId, model, state.index, false, "", true, name, "");
          }
          const args = perchToolArgumentsDelta(call, sealed);
          if (!args) continue;
          if (sealed && state.emittedArgs) continue;
          state.emittedArgs = true;
          perchToolDeltaChunk(out, completionId, model, state.index, false, "", false, "", args);
        }
        break;
      }
      case "done": {
        const ok = event.ok === true;
        if (!ok) {
          const message = perchErrorMessage(event);
          if (message) {
            ensureRole(out);
            perchWriteChunk(out, completionId, model, { content: message }, null);
          }
        }
        const finish = tools.size > 0 && ok ? "tool_calls" : "stop";
        perchWriteChunk(out, completionId, model, {}, finish, perchUsageToChatUsage(event.usage));
        out.push("data: [DONE]\n\n");
        doneFlag = true;
        break;
      }
      default:
        break;
    }
    return out;
  }
}

function perchSseToChatStream(
  source: ReadableStream<Uint8Array>,
  model: string,
  includeReasoning: boolean
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const iterator = transformPerchSseToChat(source, model, includeReasoning)[Symbol.asyncIterator]();
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

async function perchSseToChatCompletion(
  resp: Response,
  model: string,
  includeReasoning: boolean
): Promise<Json> {
  const text = await resp.text();
  let content = "";
  let reasoning = "";
  const toolCalls: unknown[] = [];
  let finishReason = "stop";
  let usage: Json | null = null;
  const orderedTools: Array<{ id: string; name: string; args: string }> = [];
  const byId = new Map<string, { id: string; name: string; args: string }>();

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "[DONE]" || trimmed.startsWith(":")) continue;
    const payload = trimmed.startsWith("data:") ? trimmed.slice("data:".length).trim() : trimmed;
    if (!payload || payload === "[DONE]") continue;
    let event: Json;
    try {
      event = JSON.parse(payload) as Json;
    } catch {
      continue;
    }
    switch (stringValue(event.type)) {
      case "reasoning_delta":
        if (includeReasoning) reasoning += stringValue(event.text);
        break;
      case "answer_delta":
        content += stringValue(event.text);
        break;
      case "tool_call_delta":
      case "tool_use_end": {
        const sealed = stringValue(event.type) === "tool_use_end";
        for (const rawCall of perchEventToolCalls(event)) {
          const call = (rawCall ?? {}) as Json;
          const id = stringValue(call.id);
          if (!id) continue;
          let tool = byId.get(id);
          if (!tool) {
            tool = { id, name: stringValue(call.name), args: "" };
            byId.set(id, tool);
            orderedTools.push(tool);
          } else if (stringValue(call.name) && !tool.name) {
            tool.name = stringValue(call.name);
          }
          if (sealed) {
            const args = perchToolSealedArguments(call);
            if (args) tool.args = args;
          } else {
            const delta = stringValue(call.rawArgumentsText);
            if (delta) tool.args += delta;
          }
        }
        break;
      }
      case "done": {
        const message = perchErrorMessage(event);
        const hasOk = typeof event.ok === "boolean";
        if (message || (hasOk && event.ok !== true)) {
          throw new PerchUpstreamError(message || "Perch request failed", perchQuotaError(message));
        }
        usage = perchUsageToChatUsage(event.usage);
        break;
      }
      default:
        break;
    }
  }

  for (const tool of orderedTools) {
    toolCalls.push({
      id: tool.id,
      type: "function",
      function: { name: tool.name, arguments: tool.args.trim() || "{}" },
    });
  }

  const message: Json = { role: "assistant", content: null };
  if (content) message.content = content;
  if (includeReasoning && reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
    finishReason = "tool_calls";
  }
  if (!usage) usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  return {
    id: randomId("chatcmpl"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage,
  };
}

export function defaultPerchValue(value: unknown, fallback: string): string {
  return defaultStringValue(value, fallback);
}

export function perchNumber(value: unknown): number {
  return numberFromAny(value);
}
