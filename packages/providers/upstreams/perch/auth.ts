import { Result } from "effect";
import { Ids, Value } from "@opendum/providers/core/helpers";
import type { Registry } from "@opendum/models/runtime";
import type { ProviderAccount } from "@opendum/providers/types";
import type { UpstreamTransport } from "@opendum/providers/core/http";
import { PERCH_ACCOUNT_PATH, PERCH_APP_URL, PERCH_CONFIG_PATH } from "@opendum/providers/auth/perch/constants";

export type Json = Record<string, unknown>;

export const TURN_TICKET_PATH = "/api/perch-terminal/turn-ticket";
export const TURN_TICKET_HEADER = "x-perch-turn-ticket";
export const MODEL_CALL_PATH = "/api/perch-terminal/model-call";
export const CLI_VERSION = "2.4.118";
export const ACCESS_TTL_MS = 60 * 60 * 1000;
export const REFRESH_BUFFER_MS = 5 * 60 * 1000;
export const CONFIG_TTL_MS = 15 * 60 * 1000;
export const SESSION_TTL_MS = 10 * 60 * 1000;
export const FALLBACK_ALIAS = "laguna-s";
export const CALL_TIMEOUT_MS = 5000;

export const MANUAL_OPTION_IDS: Record<string, string> = {
  "laguna-s": "poolside-poolside-laguna-s-2-1",
  "deepseek-flash-starter": "openrouter-deepseek-deepseek-v4-1-flash",
  "glm-5.3-flash-starter": "openrouter-z-ai-glm-5-3-flash",
  "qwen-3.8-27b": "openrouter-qwen-qwen3-8-27b",
  "qwen-3.8-flash": "openrouter-qwen-qwen3-8-flash",
  "qwen-3.8-max": "openrouter-qwen-qwen3-8-max-0902",
};

export type AuthConfig = { supabaseUrl: string; anonKey: string };
export type SessionIds = { userId: string; workspaceId: string };

export class UpstreamError extends Error {
  readonly quota: boolean;

  constructor(message: string, quota: boolean) {
    super(message);
    this.name = "PerchUpstreamError";
    this.quota = quota;
  }
}

export class PerchAuth {
  private cache: { config: AuthConfig; fetchedAt: number } | null = null;

  private readonly sessions = new Map<string, { ids: SessionIds; fetchedAt: number }>();

  private readonly transport: UpstreamTransport;

  constructor(transport: UpstreamTransport) {
    this.transport = transport;
  }

  private static headers(config: AuthConfig): Record<string, string> {
    return {
      "Content-Type": "application/json",
      apikey: config.anonKey,
      Authorization: `Bearer ${config.anonKey}`,
    };
  }

  async config(): Promise<Result.Result<AuthConfig, string>> {
    if (this.cache && Date.now() - this.cache.fetchedAt < CONFIG_TTL_MS) {
      return Result.succeed(this.cache.config);
    }
    const resp = await this.transport.direct(`${PERCH_APP_URL}${PERCH_CONFIG_PATH}`, {
      headers: { Accept: "application/json" },
    });
    if (resp.status < 200 || resp.status >= 300) {
      return Result.fail(`perch auth config request failed: ${resp.status}`);
    }
    const payload = (await resp.json()) as { supabaseUrl?: string; supabaseAnonKey?: string };
    const supabaseUrl = (payload.supabaseUrl ?? "").trim();
    const anonKey = (payload.supabaseAnonKey ?? "").trim();
    if (!supabaseUrl || !anonKey) return Result.fail("perch auth config is incomplete");
    const config = { supabaseUrl: supabaseUrl.replace(/\/+$/, ""), anonKey };
    this.cache = { config, fetchedAt: Date.now() };
    return Result.succeed(config);
  }

  async tokenHeaders(): Promise<Result.Result<Record<string, string>, string>> {
    const config = await this.config();
    return Result.isFailure(config) ? Result.fail(config.failure) : Result.succeed(PerchAuth.headers(config.success));
  }

  async sessionIds(account: ProviderAccount, accessToken: string): Promise<SessionIds | null> {
    if (!account.id) return null;
    const cached = this.sessions.get(account.id);
    if (cached && Date.now() - cached.fetchedAt < SESSION_TTL_MS) return cached.ids;
    const fetched = await this.transport
      .direct(`${PERCH_APP_URL}${PERCH_ACCOUNT_PATH}`, {
        headers: { Accept: "application/json", Authorization: `Bearer ${accessToken.trim()}` },
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      })
      .catch(() => null);
    if (!fetched) return null;
    if (fetched.status < 200 || fetched.status >= 300) return null;
    const payload = (await fetched.json().catch(() => null)) as {
      ok?: boolean;
      session?: { userId?: string; workspaceId?: string };
    } | null;
    if (!payload?.ok) return null;
    const ids = {
      userId: payload.session?.userId ?? "",
      workspaceId: payload.session?.workspaceId ?? "",
    };
    this.sessions.set(account.id, { ids, fetchedAt: Date.now() });
    return ids;
  }

  async turnTicket(accessToken: string): Promise<Result.Result<{ ticket: string; runId: string }, string>> {
    const resp = await this.transport.direct(`${PERCH_APP_URL}${TURN_TICKET_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${accessToken.trim()}`,
        "User-Agent": PerchAuth.userAgent(),
      },
      body: JSON.stringify({ surface: "cli", profile: "standard" }),
    });
    if (resp.status < 200 || resp.status >= 300) {
      return Result.fail(`perch turn ticket failed: ${resp.status} ${(await resp.text()).slice(0, 1024)}`);
    }
    const result = (await resp.json()) as {
      ok?: boolean;
      ticket?: string;
      runId?: string;
      error?: string;
    };
    if (result.ok === false) {
      return Result.fail((result.error ?? "").trim() || "Perch turn ticket request failed");
    }
    const ticket = (result.ticket ?? "").trim();
    const runId = (result.runId ?? "").trim();
    if (!ticket || !runId) {
      return Result.fail((result.error ?? "").trim() || "Perch turn ticket returned incomplete credentials");
    }
    return Result.succeed({ ticket, runId });
  }

  static userAgent(): string {
    return `perchai-cli/${CLI_VERSION}`;
  }

  static runId(): string {
    return `cli-turn-${Date.now()}-${Ids.hex(crypto.getRandomValues(new Uint8Array(4)))}`;
  }
}

export class PerchModels {
  static alias(registry: Registry, model: string): string {
    let value = model.trim();
    if (value.startsWith("perch/")) value = value.slice("perch/".length);
    value = registry.upstream(value, "perch");
    return value || FALLBACK_ALIAS;
  }

  static supported(registry: Registry): string {
    return registry.models("perch").sort((a, b) => a.localeCompare(b)).join(", ");
  }

  static effort(body: Json): { level: string; reasoningEnabled: boolean } {
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

  static firstNonNil(...values: unknown[]): unknown {
    for (const value of values) {
      if (value !== undefined && value !== null) return value;
    }
    return null;
  }
}

export class PerchUsage {
  static toChat(raw: unknown): Json | null {
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

  static errorMessage(event: Json): string {
    const text = Value.string(event.error);
    if (text) return text;
    if (event.error !== undefined && event.error !== null) return JSON.stringify(event.error);
    return "";
  }

  static isQuota(message: string): boolean {
    const lower = message.toLowerCase();
    return ["allowance", "quota", "limit", "usage", "billing", "credit"].some((marker) =>
      lower.includes(marker)
    );
  }
}
