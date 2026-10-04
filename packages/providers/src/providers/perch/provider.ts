import { randomBytes } from "node:crypto";
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

import { PERCH_ACCOUNT_PATH, PERCH_APP_URL, PERCH_AUTH_CONFIG_PATH } from "#providers/api/endpoints.ts";
import { PerchUpstreamError, perchSseToChatCompletion, perchSseToChatStream } from "#providers/providers/perch/sse.ts";

export { PerchUpstreamError } from "#providers/providers/perch/sse.ts";

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
