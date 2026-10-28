import { Effect, Result } from "effect";
import type { OpendumRedis } from "@opendum/core/redis";
import { Value, Payload, Responses, JSONText } from "@opendum/providers/core/helpers";
import { Jwt, ModelName } from "@opendum/providers/core/identity";
import { Collector } from "@opendum/providers/transform/collector";
import { anthropicUsage } from "@opendum/providers/transform/anthropic";
import {
  toolsFor,
  toInput,
  inputOf,
  sseStream,
  callId,
} from "@opendum/providers/transform/responses";
import { RequestFailure } from "@opendum/providers/core/http";
import { OAuth } from "@opendum/providers/core/oauth";
import { OAuthProvider, type ProviderOptions } from "@opendum/providers/core/provider";
import type {
  ProviderAccount,
  ProviderFailure,
  ProviderRequest,
  RefreshedCredentials,
  ProviderCredentialFailure,
} from "@opendum/providers/types";

import { CLIENT_ID as CODEX_CLIENT_ID, CODEX_BASE_URL, ORIGINATOR as CODEX_ORIGINATOR, TOKEN_ENDPOINT as CODEX_TOKEN_ENDPOINT } from "@opendum/providers/auth/codex/constants";
import { compareText } from "@opendum/models/compare";

export const SUPPORTED_CODEX = new Set([
  "model", "instructions", "store", "input", "stream", "tools", "tool_choice",
  "parallel_tool_calls", "reasoning", "include", "previous_response_id", "prompt_cache_key",
  "client_metadata", "service_tier",
]);

type Json = Record<string, unknown>;

function buildPayload(body: Json, modelName: string, upstreamStream: boolean): Json {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const payload: Json = { model: modelName, store: false, stream: upstreamStream };
  const instructions = Value.string(body.instructions);
  if (instructions) {
    payload.instructions = instructions;
  } else {
    const derived = Payload.instructions(messages);
    payload.instructions = derived || "You are Codex, an expert coding assistant.";
  }
  if (Array.isArray(body._responsesInput) && body._responsesInput.length > 0) {
    payload.input = inputOf(body._responsesInput);
  } else {
    payload.input = toInput(messages);
  }
  const tools = toolsFor(body.tools);
  if (tools.length > 0) {
    payload.tools = tools;
    if (body.tool_choice === undefined || body.tool_choice === null) payload.tool_choice = "auto";
  }
  if (body.tool_choice !== undefined && body.tool_choice !== null) {
    payload.tool_choice = Payload.toolChoice(body.tool_choice);
  }
  if (body.parallel_tool_calls !== undefined && body.parallel_tool_calls !== null) {
    payload.parallel_tool_calls = body.parallel_tool_calls;
  }
  if (body.reasoning !== null && typeof body.reasoning === "object" && !Array.isArray(body.reasoning)) {
    payload.reasoning = Payload.clone(body.reasoning as Json);
  } else {
    const effort = Value.string(body.reasoning_effort);
    if (effort) payload.reasoning = { effort };
  }
  const reasoning = payload.reasoning;
  if (
    reasoning !== null &&
    typeof reasoning === "object" &&
    !Array.isArray(reasoning) &&
    body._includeReasoning === true &&
    (reasoning as Json).summary === undefined
  ) {
    (reasoning as Json).summary = "auto";
  }
  const include = Value.strings(body.include);
  if (body._includeReasoning === true || tools.length > 0) {
    include.push("reasoning.encrypted_content");
  }
  if (include.length > 0) payload.include = Value.unique(include);
  for (const key of ["previous_response_id", "service_tier"]) {
    if (body[key] !== undefined && body[key] !== null) payload[key] = body[key];
  }
  const sessionId = Value.string(body._sessionId);
  if (sessionId) {
    payload.prompt_cache_key = sessionId;
    payload.client_metadata = { session_id: sessionId };
  }
  return Payload.filter(payload, SUPPORTED_CODEX);

}

function claimString(claims: Json, key: string): string {
  return Jwt.claim(claims, key);
}

function organizationId(claims: Json): string {
  const organizations = Array.isArray(claims.organizations) ? claims.organizations : [];
  for (const preferDefault of [true, false]) {
    for (const raw of organizations) {
      const org = (raw ?? {}) as Json;
      const isDefault = org.is_default === true || org.default === true;
      if (preferDefault && !isDefault) continue;
      const value = Value.string(org.id).trim();
      if (value) return value;
    }
  }
  return "";
}

function jwtAccount(token: string): string {
  const claims = Jwt.claims(token);
  if (!claims) return "";
  const accountId = claimString(claims, "chatgpt_account_id");
  if (accountId) return accountId;
  return claimsWorkspace(claims);
}

function claimsWorkspace(claims: Json): string {
  const authClaims = Jwt.nested(claims, "https://api.openai.com/auth");
  for (const source of [authClaims, claims]) {
    if (!source) continue;
    for (const key of ["chatgpt_workspace_id", "workspace_id", "organization_id"]) {
      const value = claimString(source, key);
      if (value) return value;
    }
    const orgId = organizationId(source);
    if (orgId) return orgId;
  }
  return "";
}

function jwtTier(token: string): string {
  const claims = Jwt.claims(token);
  if (!claims) return "";
  const direct = claimString(claims, "chatgpt_plan_type");
  if (direct) return direct.toLowerCase();
  return claimString(Jwt.nested(claims, "https://api.openai.com/auth") ?? {}, "chatgpt_plan_type").toLowerCase();
}

function toFloat(value: string): number {
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed > 100 ? 100 : parsed;
}

function toInt(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseBool(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "1";
}

function resetTimestamp(value: number | null): number | null {
  if (!value || value <= 0) return null;
  return value > 10_000_000_000 ? value : value * 1000;
}

function quotaWindow(used: string, windowMinutes: string, resetAt: string): Json {
  const usedPercent = toFloat(used);
  let remaining = 100 - usedPercent;
  if (remaining < 0) remaining = 0;
  const reset = toInt(resetAt);
  return {
    usedPercent,
    remainingPercent: remaining,
    remainingFraction: remaining / 100,
    windowMinutes: toInt(windowMinutes),
    resetAt: reset,
    resetTimestamp: resetTimestamp(reset),
    isExhausted: usedPercent >= 100,
  };
}

function readQuota(headers: Headers): Json | null {
  const primaryUsed = headers.get("x-codex-primary-used-percent") ?? "";
  const secondaryUsed = headers.get("x-codex-secondary-used-percent") ?? "";
  const credits = headers.get("x-codex-credits-has-credits") ?? "";
  if (!primaryUsed && !secondaryUsed && !credits) return null;
  const snapshot: Json = { planType: null, primary: null, secondary: null, credits: null };
  if (primaryUsed) {
    snapshot.primary = quotaWindow(
      primaryUsed,
      headers.get("x-codex-primary-window-minutes") ?? "",
      headers.get("x-codex-primary-reset-at") ?? ""
    );
  }
  if (secondaryUsed) {
    snapshot.secondary = quotaWindow(
      secondaryUsed,
      headers.get("x-codex-secondary-window-minutes") ?? "",
      headers.get("x-codex-secondary-reset-at") ?? ""
    );
  }
  if (credits) {
    snapshot.credits = {
      hasCredits: parseBool(credits),
      unlimited: parseBool(headers.get("x-codex-credits-unlimited") ?? ""),
      balance: (headers.get("x-codex-credits-balance") ?? "") || null,
    };
  }
  return snapshot;
}

export type CodexOptions = ProviderOptions & {
  redis?: OpendumRedis | null;
  onAccountId?: (accountId: string) => void;
};

export class CodexProvider extends OAuthProvider {
  readonly name = "codex";
  protected readonly refreshBufferMs = 5 * 60 * 1000;
  private readonly redis: OpendumRedis | null;
  private readonly onAccountId: ((accountId: string) => void) | undefined;
  private readonly oauth: OAuth;

  constructor(options: CodexOptions) {
    super(options);
    this.oauth = new OAuth({
      provider: "codex",
      tokenUrl: CODEX_TOKEN_ENDPOINT,
      transport: options.transport,
      request: (refreshToken) => ({
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken.trim(),
          client_id: CODEX_CLIENT_ID,
        }).toString(),
      }),
      parse: (payload, refreshToken) => {
        const token = payload as {
          access_token?: string;
          refresh_token?: string;
          expires_in?: number;
          id_token?: string;
        };
        const accessToken = token.access_token ?? "";
        if (!accessToken) return Result.fail("codex token refresh returned empty access token");
        const nextRefresh = token.refresh_token || refreshToken;
        const expiresIn = token.expires_in && token.expires_in > 0 ? token.expires_in : 3600;
        let accountId = jwtAccount(accessToken);
        if (!accountId && token.id_token) accountId = jwtAccount(token.id_token);
        let tier = "";
        if (token.id_token) tier = jwtTier(token.id_token);
        if (!tier) tier = jwtTier(accessToken);
        return Result.succeed({
          accessToken,
          refreshToken: nextRefresh,
          expiresAt: new Date(Date.now() + expiresIn * 1000),
          tier,
          accountId,
        });
      },
    });
    this.redis = options.redis ?? null;
    this.onAccountId = options.onAccountId;
  }

  protected exchange(
    refreshToken: string,
    account: ProviderAccount
  ): Effect.Effect<RefreshedCredentials, ProviderCredentialFailure> {
    return this.oauth.exchange(refreshToken, account);
  }

  makeRequest(request: ProviderRequest): Effect.Effect<Response, ProviderFailure> {
    const modelName = this.resolveModel(Value.string(request.body.model));
    const account = request.account;
    let accountId = account.accountId?.trim() ?? "";
    if (!accountId) {
      const extracted = jwtAccount(request.credentials);
      if (extracted) {
        accountId = extracted;
        this.onAccountId?.(extracted);
      }
    }
    if (!this.isModelAllowed(modelName)) {
      return Effect.succeed(
        Responses.json(400, {
          error: {
            message: `Model "${modelName}" is not supported for Codex when using a ChatGPT account. Use one of: ${this.supportedModelNames().join(
              ", "
            )}.`,
            type: "invalid_request_error",
            param: "model",
            code: "unsupported_codex_chatgpt_model",
          },
        })
      );
    }

    const payload = buildPayload(request.body, modelName, true);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${request.credentials.trim()}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      originator: CODEX_ORIGINATOR,
      "User-Agent": `opencode/1.19.5 (${process.platform} ${process.platform}; ${process.arch})`,
    };
    if (accountId) headers["ChatGPT-Account-Id"] = accountId;
    const sessionId = Value.string(request.body._sessionId);
    if (sessionId) headers.session_id = sessionId;

    const transport = this.transport;
    return Effect.gen({ self: this }, function* () {
      const resp = yield* Effect.tryPromise({
        try: () =>
          transport.direct(CODEX_BASE_URL, {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
          }),
        catch: (cause) => RequestFailure.transport("codex", cause, CODEX_BASE_URL),
      });
      if (resp.status < 200 || resp.status >= 300) return resp;
      request.onResponseStart?.();
      void this.applyQuota(account.id, resp.headers);
      if (request.stream && resp.body) {
        return new Response(sseStream(resp.body, modelName), {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      }
      const text = yield* Effect.promise(() => resp.text());
      return Responses.json(200, fromResponses(text, modelName));
    });
  }

  private async applyQuota(accountId: string, headers: Headers): Promise<void> {
    if (!this.redis || !accountId) return;
    const snapshot = readQuota(headers);
    if (!snapshot) return;
    snapshot.status = "success";
    snapshot.source = "headers";
    snapshot.fetchedAt = Date.now();
    await this.redis
      .set(`opendum:quota:codex:snapshot:${accountId}`, JSON.stringify(snapshot), { EX: 15 * 60 })
      .catch(() => undefined);
  }

  private isModelAllowed(model: string): boolean {
    const normalized = model.trim().toLowerCase();
    for (const [canonical, upstream] of this.registry.modelMap("codex")) {
      if (canonical.toLowerCase() === normalized || upstream.toLowerCase() === normalized) return true;
    }
    return false;
  }

  private supportedModelNames(): string[] {
    const values = new Set<string>();
    for (const [canonical, upstream] of this.registry.modelMap("codex")) {
      if (canonical) values.add(canonical);
      if (upstream) values.add(upstream);
    }
    return [...values].sort((a, b) => compareText(a, b));
  }

  private resolveModel(model: string): string {
    return this.registry.upstream(ModelName.segment(model), "codex");
  }
}

export function fromResponses(text: string, model: string): Json {
  const events = JSONText.sseLines(text);
  const collector = new Collector({
    model,
    nullContent: true,
    normalizeArgs: (args) => Value.stringOr(args, "{}"),
    forceFinish: true,
  });
  const reasoningParts = new Map<string, string>();
  const reasoningOrder: string[] = [];
  const appendReasoning = (key: string, part: string): void => {
    if (!part) return;
    const existing = reasoningParts.get(key) ?? "";
    let missing = part;
    if (part.startsWith(existing)) missing = part.slice(existing.length);
    if (!missing) return;
    if (!reasoningParts.has(key)) reasoningOrder.push(key);
    reasoningParts.set(key, existing + missing);
  };
  const addReasoningItem = (item: Json): void => {
    if (Array.isArray(item.summary) && item.summary.length > 0) {
      item.summary.forEach((raw, index) => {
        const value = typeof raw === "string" ? raw : Value.string((raw as Json)?.text);
        if (value) appendReasoning(`summary:${index}`, value);
      });
      return;
    }
    if (Array.isArray(item.content) && item.content.length > 0) {
      item.content.forEach((raw, index) => {
        const value = Value.string((raw as Json)?.text);
        if (value) appendReasoning(`text:${index}`, value);
      });
      return;
    }
    const textValue = Value.string(item.text);
    if (textValue) appendReasoning("text:0", textValue);
  };

  let currentTool: Json | null = null;
  let status = "";
  let rawUsage: unknown = {};
  for (const event of events) {
    switch (Value.string(event.type)) {
      case "response.output_text.delta":
        collector.addContent(Value.string(event.delta));
        break;
      case "response.reasoning.delta":
      case "response.reasoning_text.delta":
        appendReasoning(`text:${Value.number(event.content_index)}`, Value.string(event.delta));
        break;
      case "response.reasoning_summary_text.delta":
        appendReasoning(`summary:${Value.number(event.summary_index)}`, Value.string(event.delta));
        break;
      case "response.reasoning_text.done":
        appendReasoning(`text:${Value.number(event.content_index)}`, Value.string(event.text));
        break;
      case "response.reasoning_summary_text.done":
        appendReasoning(`summary:${Value.number(event.summary_index)}`, Value.string(event.text));
        break;
      case "response.reasoning_summary_part.done": {
        const part = (event.part ?? {}) as Json;
        let value = Value.string(part.text);
        if (!value) value = Value.string(event.text);
        appendReasoning(`summary:${Value.number(event.summary_index)}`, value);
        break;
      }
      case "response.output_item.added": {
        const item = (event.item ?? {}) as Json;
        if (item.type === "function_call") {
          currentTool = {
            type: "function_call",
            id: item.id,
            call_id: item.call_id,
            name: item.name,
            arguments: "",
          };
        }
        break;
      }
      case "response.function_call_arguments.delta":
      case "response.custom_tool_call_input.delta":
        if (currentTool) {
          currentTool.arguments = Value.string(currentTool.arguments) + Value.string(event.delta);
        }
        break;
      case "response.function_call_arguments.done":
      case "response.output_item.done": {
        const item = (event.item ?? {}) as Json;
        if (item.type === "reasoning") addReasoningItem(item);
        if (currentTool) {
          const mappedId = callId(Value.stringOr(currentTool.call_id, Value.string(currentTool.id)));
          collector.addToolCall({
            key: mappedId,
            id: mappedId,
            name: Value.string(currentTool.name),
            arguments: Value.string(currentTool.arguments),
          });
          currentTool = null;
        }
        break;
      }
      case "response.completed":
      case "response.done": {
        const response = (event.response ?? event) as Json;
        status = Value.string(response.status);
        rawUsage = response.usage;
        break;
      }
      default:
        break;
    }
  }

  const reasoningText = reasoningOrder
    .flatMap((key) => {
      const value = reasoningParts.get(key);
      return value ? [value] : [];
    })
    .join("\n\n");
  collector.addReasoning(reasoningText);
  collector.setFinish(status === "incomplete" ? "length" : "stop");
  collector.setUsage(anthropicUsage(rawUsage));
  return collector.toCompletion();
}
