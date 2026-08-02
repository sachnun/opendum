import type Redis from "ioredis";
import type { ProxyDB } from "../db/index.js";
import { schema } from "../db/index.js";
import { eq } from "drizzle-orm";
import type { Registry } from "../registry/index.js";
import { jsonResponse, sseResponse, stringValue, readAllText, randomID } from "./http.js";
import { parseSSEDataLines } from "./model_helpers.js";
import { responsesJSONToChatCompletion, normalizeResponsesInput, messagesToResponsesInput, convertToolsForResponses, toChatCallID } from "./responses_transform.js";
import { defaultStringValue } from "./http.js";
import { normalizeToolChoiceHelper } from "./providers-helpers.js";
import type { HttpClient, Provider, ProviderAccountLike, RefreshedCredentials, RequestContext, UpstreamResponse } from "./types.js";
import { markUpstreamResponseStarted } from "./latency.js";

const codexClientID = "app_EMoamEEZ73f0CkXaXp7hrann";
const codexTokenEndpoint = "https://auth.openai.com/oauth/token";
const codexAPIBaseURL = "https://chatgpt.com/backend-api/codex/responses";
const codexOriginator = "opencode";

const supportedCodex = new Set(["model", "instructions", "store", "input", "stream", "tools", "tool_choice", "parallel_tool_calls", "reasoning", "include", "previous_response_id", "prompt_cache_key", "client_metadata", "service_tier"]);

export class CodexProvider implements Provider {
  constructor(
    private registry: Registry | null,
    private redis: Redis | null,
    private db: ProxyDB | null,
  ) {}

  refreshBuffer(): number {
    return 5 * 60 * 1000;
  }

  async refreshCredentials(ctx: RequestContext, client: HttpClient, refreshToken: string, _account: ProviderAccountLike): Promise<RefreshedCredentials> {
    const form = new URLSearchParams();
    form.set("grant_type", "refresh_token");
    form.set("refresh_token", refreshToken.trim());
    form.set("client_id", codexClientID);
    const resp = await client.fetch(codexTokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: form.toString(),
      signal: ctx.signal,
    });
    if (resp.status < 200 || resp.status >= 300) {
      const body = await readAllText(resp.body);
      throw new Error(`codex token refresh failed: ${resp.status} ${body}`);
    }
    const token = (await readAllJSONSafe(resp.body)) as Record<string, unknown>;
    const accessToken = stringValue(token["access_token"]);
    if (accessToken === "") {
      throw new Error("codex token refresh returned empty access token");
    }
    let newRefreshToken = stringValue(token["refresh_token"]);
    if (newRefreshToken === "") newRefreshToken = refreshToken;
    let expiresIn = Number(token["expires_in"] ?? 0);
    if (expiresIn <= 0) expiresIn = 3600;
    const idToken = stringValue(token["id_token"]);
    let accountID = extractAccountIDFromJWT(accessToken);
    if (accountID === "" && idToken !== "") accountID = extractAccountIDFromJWT(idToken);
    let tier = "";
    if (idToken !== "") tier = extractTierFromJWT(idToken);
    if (tier === "") tier = extractTierFromJWT(accessToken);
    return { accessToken, refreshToken: newRefreshToken, expiresAt: new Date(Date.now() + expiresIn * 1000), tier, accountId: accountID, projectId: "", email: "", storeAccessToken: "" };
  }

  async makeRequest(client: HttpClient, ctx: RequestContext, accessToken: string, account: ProviderAccountLike, body: Record<string, unknown>, stream: boolean): Promise<UpstreamResponse> {
    const modelName = this.resolveModel(stringValue(body["model"]));
    let acc = { ...account };
    if (acc.accountId === null || acc.accountId.trim() === "") {
      const accountID = extractAccountIDFromJWT(accessToken);
      if (accountID !== "") {
        acc.accountId = accountID;
        if (this.db && acc.id !== "") {
          void this.db.update(schema.providerAccount).set({ accountId: accountID }).where(eq(schema.providerAccount.id, acc.id));
        }
      }
    }
    if (!this.isModelAllowed(modelName)) {
      return jsonResponse(400, { error: { message: `Model "${modelName}" is not supported for Codex when using a ChatGPT account. Use one of: ${this.supportedModelNames().join(", ")}.`, type: "invalid_request_error", param: "model", code: "unsupported_codex_chatgpt_model" } });
    }
    const payload = this.buildPayload(body, modelName, true);
    const headers: Record<string, string> = {
      authorization: "Bearer " + accessToken.trim(),
      "content-type": "application/json",
      accept: "text/event-stream",
      originator: codexOriginator,
      "user-agent": "opencode/1.14.28 (linux linux; x64)",
    };
    const accountID = accountIDForCodex(acc, accessToken);
    if (accountID !== "") headers["chatgpt-account-id"] = accountID;
    const sessionID = stringValue(body["_sessionId"]);
    if (sessionID !== "") headers["session_id"] = sessionID;

    const resp = await client.fetch(codexAPIBaseURL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: ctx.signal,
    });
    if (resp.status < 200 || resp.status >= 300) return resp;
    if (typeof (ctx as { recordResponseStart?: unknown }).recordResponseStart === "function") markUpstreamResponseStarted(ctx as never);
    this.updateQuotaFromHeaders(acc.id, resp.headers);
    if (stream) {
      return sseResponse(transformResponsesToChatGen(resp.body, modelName));
    }
    const converted = await responsesStreamToCompletion(resp.body, modelName);
    return jsonResponse(200, converted);
  }

  isModelAllowed(model: string): boolean {
    if (!this.registry) return true;
    const normalized = model.trim().toLowerCase();
    for (const [canonical, upstream] of this.registry.providerModelMapFor("codex")) {
      if (canonical.toLowerCase() === normalized || upstream.toLowerCase() === normalized) return true;
    }
    return false;
  }

  supportedModelNames(): string[] {
    if (!this.registry) return [];
    const values = new Set<string>();
    for (const [canonical, upstream] of this.registry.providerModelMapFor("codex")) {
      for (const value of [canonical, upstream]) {
        if (value !== "") values.add(value);
      }
    }
    return [...values].sort();
  }

  updateQuotaFromHeaders(accountID: string, headers: Record<string, string>): void {
    if (!this.redis || accountID === "") return;
    const snapshot = parseCodexQuotaHeaders(headers);
    if (snapshot === null) return;
    snapshot["status"] = "success";
    snapshot["source"] = "headers";
    snapshot["fetchedAt"] = Date.now();
    void this.redis.set("opendum:quota:codex:snapshot:" + accountID, JSON.stringify(snapshot), "PX", 15 * 60 * 1000);
  }

  buildPayload(body: Record<string, unknown>, modelName: string, upstreamStream: boolean): Record<string, unknown> {
    const messages = (body["messages"] ?? []) as unknown[];
    const payload: Record<string, unknown> = { model: modelName, store: false, stream: upstreamStream };
    const instructions = stringValue(body["instructions"]);
    if (instructions !== "") {
      payload["instructions"] = instructions;
    } else {
      const derived = extractInstructionsHelper(messages);
      if (derived !== "") {
        payload["instructions"] = derived;
      } else {
        payload["instructions"] = "You are Codex, an expert coding assistant.";
      }
    }
    const input = body["_responsesInput"];
    if (Array.isArray(input) && input.length > 0) {
      payload["input"] = normalizeResponsesInput(input);
    } else {
      payload["input"] = messagesToResponsesInput(messages);
    }
    const tools = convertToolsForResponses(body["tools"]);
    if (tools.length > 0) {
      payload["tools"] = tools;
      if (body["tool_choice"] === undefined || body["tool_choice"] === null) {
        payload["tool_choice"] = "auto";
      }
    }
    if (body["tool_choice"] !== undefined && body["tool_choice"] !== null) {
      payload["tool_choice"] = normalizeToolChoiceHelper(body["tool_choice"]);
    }
    if (body["parallel_tool_calls"] !== undefined && body["parallel_tool_calls"] !== null) {
      payload["parallel_tool_calls"] = body["parallel_tool_calls"];
    }
    if (body["reasoning"] && typeof body["reasoning"] === "object") {
      payload["reasoning"] = cloneAnyMap(body["reasoning"] as Record<string, unknown>);
    } else if (stringValue(body["reasoning_effort"]) !== "") {
      payload["reasoning"] = { effort: stringValue(body["reasoning_effort"]) };
    }
    const reasoning = payload["reasoning"];
    if (reasoning && typeof reasoning === "object" && body["_includeReasoning"] === true) {
      const r = reasoning as Record<string, unknown>;
      if (r["summary"] === undefined) r["summary"] = "auto";
    }
    let include = stringSlice(body["include"]);
    if (body["_includeReasoning"] === true || convertToolsForResponses(body["tools"]).length > 0) {
      include.push("reasoning.encrypted_content");
    }
    if (include.length > 0) {
      payload["include"] = uniqueStrings(include);
    }
    for (const key of ["previous_response_id", "service_tier"]) {
      if (body[key] !== undefined && body[key] !== null) payload[key] = body[key];
    }
    const sessionID = stringValue(body["_sessionId"]);
    if (sessionID !== "") {
      payload["prompt_cache_key"] = sessionID;
      payload["client_metadata"] = { session_id: sessionID };
    }
    return filterKeys(payload, supportedCodex);
  }

  resolveModel(model: string): string {
    model = lastModelSegment(model);
    if (this.registry) return this.registry.upstreamModelName(model, "codex");
    return model;
  }
}

export function accountIDForCodex(account: ProviderAccountLike, accessToken: string): string {
  if (account.accountId !== null && account.accountId.trim() !== "") {
    return account.accountId.trim();
  }
  return extractAccountIDFromJWT(accessToken);
}

export function parseCodexQuotaHeaders(headers: Record<string, string>): Record<string, unknown> | null {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  const primaryUsed = lower["x-codex-primary-used-percent"] ?? "";
  const secondaryUsed = lower["x-codex-secondary-used-percent"] ?? "";
  const credits = lower["x-codex-credits-has-credits"] ?? "";
  if (primaryUsed === "" && secondaryUsed === "" && credits === "") return null;
  const snapshot: Record<string, unknown> = { planType: null, primary: null, secondary: null, credits: null };
  if (primaryUsed !== "") {
    snapshot["primary"] = quotaWindow(primaryUsed, lower["x-codex-primary-window-minutes"] ?? "", lower["x-codex-primary-reset-at"] ?? "");
  }
  if (secondaryUsed !== "") {
    snapshot["secondary"] = quotaWindow(secondaryUsed, lower["x-codex-secondary-window-minutes"] ?? "", lower["x-codex-secondary-reset-at"] ?? "");
  }
  if (credits !== "") {
    snapshot["credits"] = { hasCredits: parseBoolString(credits), unlimited: parseBoolString(lower["x-codex-credits-unlimited"] ?? ""), balance: nullableString(lower["x-codex-credits-balance"] ?? "") };
  }
  return snapshot;
}

function quotaWindow(used: string, windowMinutes: string, resetAt: string): Record<string, unknown> {
  const usedPercent = parseFloatString(used);
  let remaining = 100 - usedPercent;
  if (remaining < 0) remaining = 0;
  return { usedPercent, remainingPercent: remaining, remainingFraction: remaining / 100, windowMinutes: parseIntString(windowMinutes), resetAt: parseIntString(resetAt), resetTimestamp: resetTimestamp(parseIntString(resetAt)), isExhausted: usedPercent >= 100 };
}

export async function responsesStreamToCompletion(body: ReadableStream<Uint8Array> | null, model: string): Promise<Record<string, unknown>> {
  const text = await readAllText(body);
  const events = parseSSEDataLines(text);
  const completion: Record<string, unknown> = { output: [], usage: {} };
  let messageContent = "";
  let reasoning = "";
  const toolCalls: unknown[] = [];
  let currentTool: Record<string, unknown> | null = null;
  for (const event of events) {
    const typ = stringValue(event["type"]);
    switch (typ) {
      case "response.output_text.delta":
        messageContent += stringValue(event["delta"]);
        break;
      case "response.reasoning.delta":
      case "response.reasoning_text.delta":
      case "response.reasoning_summary_text.delta":
        reasoning += stringValue(event["delta"]);
        break;
      case "response.output_item.added": {
        const item = (event["item"] ?? {}) as Record<string, unknown>;
        if (item["type"] === "function_call") {
          currentTool = { type: "function_call", id: item["id"], call_id: item["call_id"], name: item["name"], arguments: "" };
        }
        break;
      }
      case "response.function_call_arguments.delta":
      case "response.custom_tool_call_input.delta":
        if (currentTool) {
          currentTool["arguments"] = stringValue(currentTool["arguments"]) + stringValue(event["delta"]);
        }
        break;
      case "response.function_call_arguments.done":
      case "response.output_item.done":
        if (currentTool) {
          toolCalls.push(currentTool);
          currentTool = null;
        }
        break;
      case "response.completed":
      case "response.done": {
        const resp = (event["response"] ?? event) as Record<string, unknown>;
        completion["status"] = resp["status"];
        completion["usage"] = resp["usage"];
        break;
      }
    }
  }
  const output: unknown[] = [];
  if (messageContent !== "") {
    output.push({ type: "message", content: [{ type: "output_text", text: messageContent }] });
  }
  if (reasoning !== "") {
    output.push({ type: "reasoning", text: reasoning });
  }
  output.push(...toolCalls);
  completion["output"] = output;
  return responsesJSONToChatCompletion(completion, model);
}

export function extractAccountIDFromJWT(token: string): string {
  const claims = jwtClaims(token);
  if (!claims) return "";
  const accountID = firstStringClaim(claims, "chatgpt_account_id");
  if (accountID !== "") return accountID;
  return extractWorkspaceIDFromClaims(claims);
}

export function extractTierFromJWT(token: string): string {
  return jwtStringClaim(token, "chatgpt_plan_type").trim().toLowerCase();
}

function jwtStringClaim(token: string, claim: string): string {
  const claims = jwtClaims(token);
  if (!claims) return "";
  const value = stringValue(claims[claim]);
  if (value !== "") return value;
  const auth = claims["https://api.openai.com/auth"];
  if (auth && typeof auth === "object") {
    return stringValue((auth as Record<string, unknown>)[claim]);
  }
  return "";
}

function jwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = Buffer.from(parts[1]!, "base64url").toString("utf8");
    return JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractWorkspaceIDFromClaims(claims: Record<string, unknown>): string {
  const auth = claims["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
  for (const source of [auth, claims]) {
    if (!source) continue;
    for (const key of ["chatgpt_workspace_id", "workspace_id", "organization_id"]) {
      const value = firstStringClaim(source, key);
      if (value !== "") return value;
    }
    const orgID = extractOrganizationID(source);
    if (orgID !== "") return orgID;
  }
  return "";
}

function firstStringClaim(claims: Record<string, unknown>, key: string): string {
  return stringValue(claims[key]).trim();
}

function extractOrganizationID(claims: Record<string, unknown>): string {
  const organizations = (claims["organizations"] ?? []) as unknown[];
  for (const preferDefault of [true, false]) {
    for (const raw of organizations) {
      const org = (raw ?? {}) as Record<string, unknown>;
      const isDefault = org["is_default"] === true || org["default"] === true;
      if (preferDefault && !isDefault) continue;
      const value = stringValue(org["id"]).trim();
      if (value !== "") return value;
    }
  }
  return "";
}

function filterKeys(input: Record<string, unknown>, supported: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (supported.has(key) && value !== undefined && value !== null) out[key] = value;
  }
  return out;
}

function stringSlice(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => stringValue(v)).filter((v) => v !== "");
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (value === "") continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function parseFloatString(value: string): number {
  const parsed = Number.parseFloat(value.trim());
  if (Number.isNaN(parsed) || parsed < 0) return 0;
  if (parsed > 100) return 100;
  return parsed;
}

function parseIntString(value: string): unknown {
  if (value.trim() === "") return null;
  const parsed = Number.parseInt(value.trim(), 10);
  if (Number.isNaN(parsed)) return null;
  return parsed;
}

function resetTimestamp(value: unknown): unknown {
  const parsed = value;
  if (typeof parsed !== "number" || parsed <= 0) return null;
  if (parsed > 10_000_000_000) return parsed;
  return parsed * 1000;
}

function parseBoolString(value: string): boolean {
  const lower = value.trim().toLowerCase();
  return lower === "true" || lower === "1";
}

function nullableString(value: string): unknown {
  return value === "" ? null : value;
}

function lastModelSegment(model: string): string {
  const idx = model.lastIndexOf("/");
  return idx >= 0 ? model.slice(idx + 1) : model;
}

function cloneAnyMap(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = cloneAnyMap(value as Record<string, unknown>);
      continue;
    }
    out[key] = value;
  }
  return out;
}

function extractInstructionsHelper(messages: unknown[]): string {
  const parts: string[] = [];
  for (const raw of messages) {
    const msg = (raw ?? {}) as Record<string, unknown>;
    const role = stringValue(msg["role"]);
    if (role !== "system" && role !== "developer") continue;
    const text = contentToTextHelper(msg["content"]).trim();
    if (text !== "") parts.push(text);
  }
  return parts.join("\n\n");
}

function contentToTextHelper(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const chunks: string[] = [];
    for (const part of content) {
      const m = (part ?? {}) as Record<string, unknown>;
      const t = stringValue(m["text"]);
      if (t !== "") chunks.push(t);
    }
    return chunks.join("");
  }
  return "";
}

async function readAllJSONSafe(body: ReadableStream<Uint8Array> | null): Promise<unknown> {
  const text = await readAllText(body);
  if (text === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function* transformResponsesToChatGen(body: ReadableStream<Uint8Array> | null, model: string): AsyncGenerator<string> {
  const { transformResponsesSSEToChat } = await import("./responses_transform.js");
  yield* transformResponsesSSEToChat(body, model);
}

