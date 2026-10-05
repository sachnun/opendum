import { randomBytes } from "node:crypto";

import type { Registry } from "@opendum/models/runtime";
import { stringValue } from "#providers/lib/helpers.ts";
import type { UpstreamTransport } from "#providers/api/http.ts";
import type { ProviderAccount } from "#providers/model/types.ts";
import { PERCH_ACCOUNT_PATH, PERCH_APP_URL, PERCH_AUTH_CONFIG_PATH } from "#providers/api/endpoints.ts";

export const PERCH_TURN_TICKET_PATH = "/api/perch-terminal/turn-ticket";
export const PERCH_TURN_TICKET_HEADER = "x-perch-turn-ticket";
export const PERCH_CLI_VERSION = "2.4.98";
export const PERCH_MODEL_CALL_PATH = "/api/perch-terminal/model-call";
export const PERCH_ACCESS_TTL_MS = 60 * 60 * 1000;
export const PERCH_REFRESH_BUFFER_MS = 5 * 60 * 1000;
export const PERCH_CONFIG_CACHE_TTL_MS = 15 * 60 * 1000;
export const PERCH_SESSION_CACHE_TTL_MS = 10 * 60 * 1000;
export const PERCH_FALLBACK_ALIAS = "qwen-3.6";
export const PERCH_CALL_TIMEOUT_MS = 5000;

export const PERCH_MANUAL_OPTION_IDS: Record<string, string> = {
  "qwen-3.6": "wandb-qwen3-6-35b-a3b",
  "kimi-2.5": "bedrock-mantle-moonshotai-kimi-k2-5",
  "glm-5": "bedrock-mantle-zai-glm-5",
  "qwen3-coder": "bedrock-mantle-qwen-qwen3-coder-480b-a35b-instruct",
  "nemotron-super": "bedrock-mantle-nvidia-nemotron-super-3-120b",
  "gemma-4-e2b": "bedrock-mantle-google-gemma-4-e2b",
  "gemma-4-31b": "bedrock-mantle-google-gemma-4-31b",
};

export type Json = Record<string, unknown>;

type PerchAuthConfig = { supabaseUrl: string; anonKey: string };

let authConfigCache: { config: PerchAuthConfig; fetchedAt: number } | null = null;
const sessionCache = new Map<string, { ids: PerchSessionIds; fetchedAt: number }>();

type PerchSessionIds = { userId: string; workspaceId: string };

export async function fetchPerchAuthConfig(transport: UpstreamTransport): Promise<PerchAuthConfig> {
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

export function perchTokenHeaders(config: PerchAuthConfig): Record<string, string> {
  return {
    "Content-Type": "application/json",
    apikey: config.anonKey,
    Authorization: `Bearer ${config.anonKey}`,
  };
}

export function perchUserAgent(): string {
  return `perchai-cli/${PERCH_CLI_VERSION}`;
}

export function perchRunId(): string {
  return `cli-turn-${Date.now()}-${randomBytes(4).toString("hex")}`;
}

export async function sessionIdsForAccount(
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

export async function perchTurnTicket(
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

export function perchTextFromContent(value: unknown): string {
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

export function perchMessages(body: Json): unknown[] {
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

export function perchTools(body: Json): unknown[] | null {
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

export function perchEffortFromBody(body: Json): { level: string; reasoningEnabled: boolean } {
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

export function perchModelAlias(registry: Registry, model: string): string {
  let value = model.trim();
  if (value.startsWith("perch/")) value = value.slice("perch/".length);
  value = registry.upstreamModelName(value, "perch");
  return value || PERCH_FALLBACK_ALIAS;
}

export function perchSupportedModels(registry: Registry): string {
  return registry.modelsForProvider("perch").sort((a, b) => a.localeCompare(b)).join(", ");
}

export function firstNonNil(...values: unknown[]): unknown {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return null;
}
