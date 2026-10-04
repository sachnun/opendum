import type { Registry } from "@opendum/models/runtime";
import type { OpendumRedis } from "@opendum/redis";
import {
  cloneAnyMap,
  extractInstructions,
  filterKeys,
  jsonResponse,
  normalizeToolChoice,
  numberFromAny,
  parseSseDataLines,
  stringSlice,
  stringValue,
  uniqueStrings,
} from "./helpers.js";
import {
  convertToolsForResponses,
  messagesToResponsesInput,
  normalizeResponsesInput,
  responsesJsonToChatCompletion,
  responsesSseToChatStream,
} from "./responses-transform.js";
import type { UpstreamTransport } from "./http.js";
import type {
  CredentialRefresher,
  Provider,
  ProviderAccount,
  ProviderRequest,
  RefreshedCredentials,
  RefreshBufferProvider,
} from "./types.js";

import {
  CODEX_API_BASE_URL,
  CODEX_CLIENT_ID,
  CODEX_ORIGINATOR,
  CODEX_TOKEN_ENDPOINT,
} from "./endpoints.js";
const CODEX_REFRESH_BUFFER_MS = 5 * 60 * 1000;

export const SUPPORTED_CODEX = new Set([
  "model", "instructions", "store", "input", "stream", "tools", "tool_choice",
  "parallel_tool_calls", "reasoning", "include", "previous_response_id", "prompt_cache_key",
  "client_metadata", "service_tier",
]);

type Json = Record<string, unknown>;

function lastModelSegment(model: string): string {
  const parts = model.split("/");
  return parts[parts.length - 1];
}

function jwtClaims(token: string): Json | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = Buffer.from(parts[1], "base64url").toString("utf8");
    const parsed = JSON.parse(payload) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Json;
    return null;
  } catch {
    return null;
  }
}

function firstStringClaim(claims: Json, key: string): string {
  return stringValue(claims[key]).trim();
}

function extractOrganizationId(claims: Json): string {
  const organizations = Array.isArray(claims.organizations) ? claims.organizations : [];
  for (const preferDefault of [true, false]) {
    for (const raw of organizations) {
      const org = (raw ?? {}) as Json;
      const isDefault = org.is_default === true || org.default === true;
      if (preferDefault && !isDefault) continue;
      const value = stringValue(org.id).trim();
      if (value) return value;
    }
  }
  return "";
}

function extractAccountIdFromJwt(token: string): string {
  const claims = jwtClaims(token);
  if (!claims) return "";
  const accountId = firstStringClaim(claims, "chatgpt_account_id");
  if (accountId) return accountId;
  return extractWorkspaceIdFromClaims(claims);
}

function extractWorkspaceIdFromClaims(claims: Json): string {
  const auth = claims["https://api.openai.com/auth"];
  const authClaims =
    auth !== null && typeof auth === "object" && !Array.isArray(auth) ? (auth as Json) : null;
  for (const source of [authClaims, claims]) {
    if (!source) continue;
    for (const key of ["chatgpt_workspace_id", "workspace_id", "organization_id"]) {
      const value = firstStringClaim(source, key);
      if (value) return value;
    }
    const orgId = extractOrganizationId(source);
    if (orgId) return orgId;
  }
  return "";
}

function extractTierFromJwt(token: string): string {
  const claims = jwtClaims(token);
  if (!claims) return "";
  const direct = stringValue(claims.chatgpt_plan_type);
  if (direct) return direct.trim().toLowerCase();
  const auth = claims["https://api.openai.com/auth"];
  if (auth !== null && typeof auth === "object" && !Array.isArray(auth)) {
    return stringValue((auth as Json).chatgpt_plan_type).trim().toLowerCase();
  }
  return "";
}

function parseFloatString(value: string): number {
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed > 100 ? 100 : parsed;
}

function parseIntString(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseBoolString(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "1";
}

function resetTimestamp(value: number | null): number | null {
  if (!value || value <= 0) return null;
  return value > 10_000_000_000 ? value : value * 1000;
}

function quotaWindow(used: string, windowMinutes: string, resetAt: string): Json {
  const usedPercent = parseFloatString(used);
  let remaining = 100 - usedPercent;
  if (remaining < 0) remaining = 0;
  const reset = parseIntString(resetAt);
  return {
    usedPercent,
    remainingPercent: remaining,
    remainingFraction: remaining / 100,
    windowMinutes: parseIntString(windowMinutes),
    resetAt: reset,
    resetTimestamp: resetTimestamp(reset),
    isExhausted: usedPercent >= 100,
  };
}

function parseCodexQuotaHeaders(headers: Headers): Json | null {
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
      hasCredits: parseBoolString(credits),
      unlimited: parseBoolString(headers.get("x-codex-credits-unlimited") ?? ""),
      balance: (headers.get("x-codex-credits-balance") ?? "") || null,
    };
  }
  return snapshot;
}

export type CodexOptions = {
  registry: Registry;
  transport: UpstreamTransport;
  redis?: OpendumRedis | null;
  onAccountId?: (accountId: string) => void;
};

export class CodexProvider implements Provider, CredentialRefresher, RefreshBufferProvider {
  readonly name = "codex";
  private readonly registry: Registry;
  private readonly transport: UpstreamTransport;
  private readonly redis: OpendumRedis | null;
  private readonly onAccountId: ((accountId: string) => void) | undefined;

  constructor(options: CodexOptions) {
    this.registry = options.registry;
    this.transport = options.transport;
    this.redis = options.redis ?? null;
    this.onAccountId = options.onAccountId;
  }

  refreshBuffer(): number {
    return CODEX_REFRESH_BUFFER_MS;
  }

  async refreshCredentials(refreshToken: string, _account: ProviderAccount): Promise<RefreshedCredentials> {
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken.trim(),
      client_id: CODEX_CLIENT_ID,
    });
    const resp = await this.transport.direct(CODEX_TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: form.toString(),
    });
    const text = await resp.text();
    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(`codex token refresh failed: ${resp.status} ${text.slice(0, 1024)}`);
    }
    const token = JSON.parse(text) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      id_token?: string;
    };
    const accessToken = token.access_token ?? "";
    if (!accessToken) throw new Error("codex token refresh returned empty access token");
    const nextRefresh = token.refresh_token || refreshToken;
    const expiresIn = token.expires_in && token.expires_in > 0 ? token.expires_in : 3600;
    let accountId = extractAccountIdFromJwt(accessToken);
    if (!accountId && token.id_token) accountId = extractAccountIdFromJwt(token.id_token);
    let tier = "";
    if (token.id_token) tier = extractTierFromJwt(token.id_token);
    if (!tier) tier = extractTierFromJwt(accessToken);
    return {
      accessToken,
      refreshToken: nextRefresh,
      expiresAt: new Date(Date.now() + expiresIn * 1000),
      tier,
      accountId,
    };
  }

  async makeRequest(request: ProviderRequest): Promise<Response> {
    const modelName = this.resolveModel(stringValue(request.body.model));
    const account = request.account;
    let accountId = account.accountId?.trim() ?? "";
    if (!accountId) {
      const extracted = extractAccountIdFromJwt(request.credentials);
      if (extracted) {
        accountId = extracted;
        this.onAccountId?.(extracted);
      }
    }
    if (!this.isModelAllowed(modelName)) {
      return jsonResponse(400, {
        error: {
          message: `Model "${modelName}" is not supported for Codex when using a ChatGPT account. Use one of: ${this.supportedModelNames().join(
            ", "
          )}.`,
          type: "invalid_request_error",
          param: "model",
          code: "unsupported_codex_chatgpt_model",
        },
      });
    }

    const payload = this.buildPayload(request.body, modelName, true);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${request.credentials.trim()}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      originator: CODEX_ORIGINATOR,
      "User-Agent": `opencode/1.14.28 (${process.platform} ${process.platform}; ${process.arch})`,
    };
    if (accountId) headers["ChatGPT-Account-Id"] = accountId;
    const sessionId = stringValue(request.body._sessionId);
    if (sessionId) headers.session_id = sessionId;

    const resp = await this.transport.direct(CODEX_API_BASE_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (resp.status < 200 || resp.status >= 300) return resp;
    request.onUpstreamResponseStart?.();
    void this.updateQuotaFromHeaders(account.id, resp.headers);
    if (request.stream && resp.body) {
      return new Response(responsesSseToChatStream(resp.body, modelName), {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }
    const text = await resp.text();
    return jsonResponse(200, responsesStreamToCompletion(text, modelName));
  }

  private async updateQuotaFromHeaders(accountId: string, headers: Headers): Promise<void> {
    if (!this.redis || !accountId) return;
    const snapshot = parseCodexQuotaHeaders(headers);
    if (!snapshot) return;
    snapshot.status = "success";
    snapshot.source = "headers";
    snapshot.fetchedAt = Date.now();
    try {
      await this.redis.set(`opendum:quota:codex:snapshot:${accountId}`, JSON.stringify(snapshot), {
        EX: 15 * 60,
      });
    } catch {
      return;
    }
  }

  private isModelAllowed(model: string): boolean {
    const normalized = model.trim().toLowerCase();
    for (const [canonical, upstream] of this.registry.providerModelMap("codex")) {
      if (canonical.toLowerCase() === normalized || upstream.toLowerCase() === normalized) return true;
    }
    return false;
  }

  private supportedModelNames(): string[] {
    const values = new Set<string>();
    for (const [canonical, upstream] of this.registry.providerModelMap("codex")) {
      if (canonical) values.add(canonical);
      if (upstream) values.add(upstream);
    }
    return [...values].sort((a, b) => a.localeCompare(b));
  }

  private buildPayload(body: Json, modelName: string, upstreamStream: boolean): Json {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const payload: Json = { model: modelName, store: false, stream: upstreamStream };
    const instructions = stringValue(body.instructions);
    if (instructions) {
      payload.instructions = instructions;
    } else {
      const derived = extractInstructions(messages);
      payload.instructions = derived || "You are Codex, an expert coding assistant.";
    }
    if (Array.isArray(body._responsesInput) && body._responsesInput.length > 0) {
      payload.input = normalizeResponsesInput(body._responsesInput);
    } else {
      payload.input = messagesToResponsesInput(messages);
    }
    const tools = convertToolsForResponses(body.tools);
    if (tools.length > 0) {
      payload.tools = tools;
      if (body.tool_choice === undefined || body.tool_choice === null) payload.tool_choice = "auto";
    }
    if (body.tool_choice !== undefined && body.tool_choice !== null) {
      payload.tool_choice = normalizeToolChoice(body.tool_choice);
    }
    if (body.parallel_tool_calls !== undefined && body.parallel_tool_calls !== null) {
      payload.parallel_tool_calls = body.parallel_tool_calls;
    }
    if (body.reasoning !== null && typeof body.reasoning === "object" && !Array.isArray(body.reasoning)) {
      payload.reasoning = cloneAnyMap(body.reasoning as Json);
    } else {
      const effort = stringValue(body.reasoning_effort);
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
    let include = stringSlice(body.include);
    if (body._includeReasoning === true || tools.length > 0) {
      include.push("reasoning.encrypted_content");
    }
    if (include.length > 0) payload.include = uniqueStrings(include);
    for (const key of ["previous_response_id", "service_tier"]) {
      if (body[key] !== undefined && body[key] !== null) payload[key] = body[key];
    }
    const sessionId = stringValue(body._sessionId);
    if (sessionId) {
      payload.prompt_cache_key = sessionId;
      payload.client_metadata = { session_id: sessionId };
    }
    return filterKeys(payload, SUPPORTED_CODEX);
  }

  private resolveModel(model: string): string {
    return this.registry.upstreamModelName(lastModelSegment(model), "codex");
  }
}

function joinReasoningParts(parts: unknown[]): string {
  const chunks: string[] = [];
  for (const raw of parts) {
    if (typeof raw === "string") {
      if (raw) chunks.push(raw);
      continue;
    }
    const part = (raw ?? {}) as Json;
    const text = stringValue(part.text);
    if (text) chunks.push(text);
  }
  return chunks.join("\n\n");
}

function extractReasoningFromItem(item: Json): string {
  if (Array.isArray(item.summary)) {
    const text = joinReasoningParts(item.summary);
    if (text) return text;
  }
  if (Array.isArray(item.content)) {
    const text = joinReasoningParts(item.content);
    if (text) return text;
  }
  return stringValue(item.text);
}

export function responsesStreamToCompletion(text: string, model: string): Json {
  const events = parseSseDataLines(text);
  const completion: Json = { output: [], usage: {} };
  let messageContent = "";
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
        const value = typeof raw === "string" ? raw : stringValue((raw as Json)?.text);
        if (value) appendReasoning(`summary:${index}`, value);
      });
      return;
    }
    if (Array.isArray(item.content) && item.content.length > 0) {
      item.content.forEach((raw, index) => {
        const value = stringValue((raw as Json)?.text);
        if (value) appendReasoning(`text:${index}`, value);
      });
      return;
    }
    const textValue = stringValue(item.text);
    if (textValue) appendReasoning("text:0", textValue);
  };

  const toolCalls: Json[] = [];
  let currentTool: Json | null = null;
  for (const event of events) {
    switch (stringValue(event.type)) {
      case "response.output_text.delta":
        messageContent += stringValue(event.delta);
        break;
      case "response.reasoning.delta":
      case "response.reasoning_text.delta":
        appendReasoning(`text:${numberFromAny(event.content_index)}`, stringValue(event.delta));
        break;
      case "response.reasoning_summary_text.delta":
        appendReasoning(`summary:${numberFromAny(event.summary_index)}`, stringValue(event.delta));
        break;
      case "response.reasoning_text.done":
        appendReasoning(`text:${numberFromAny(event.content_index)}`, stringValue(event.text));
        break;
      case "response.reasoning_summary_text.done":
        appendReasoning(`summary:${numberFromAny(event.summary_index)}`, stringValue(event.text));
        break;
      case "response.reasoning_summary_part.done": {
        const part = (event.part ?? {}) as Json;
        let value = stringValue(part.text);
        if (!value) value = stringValue(event.text);
        appendReasoning(`summary:${numberFromAny(event.summary_index)}`, value);
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
          currentTool.arguments = stringValue(currentTool.arguments) + stringValue(event.delta);
        }
        break;
      case "response.function_call_arguments.done":
      case "response.output_item.done": {
        const item = (event.item ?? {}) as Json;
        if (item.type === "reasoning") addReasoningItem(item);
        if (currentTool) {
          toolCalls.push(currentTool);
          currentTool = null;
        }
        break;
      }
      case "response.completed":
      case "response.done": {
        const response = (event.response ?? event) as Json;
        completion.status = response.status;
        completion.usage = response.usage;
        break;
      }
      default:
        break;
    }
  }

  const output: unknown[] = [];
  if (messageContent) {
    output.push({ type: "message", content: [{ type: "output_text", text: messageContent }] });
  }
  const reasoningText = reasoningOrder
    .map((key) => reasoningParts.get(key) ?? "")
    .filter((value) => value)
    .join("\n\n");
  if (reasoningText) output.push({ type: "reasoning", text: reasoningText });
  output.push(...toolCalls);
  completion.output = output;
  return responsesJsonToChatCompletion(completion, model);
}
