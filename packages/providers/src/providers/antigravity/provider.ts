import { createHash } from "node:crypto";
import type { Registry } from "@opendum/models/runtime";
import type { OpendumRedis } from "@opendum/redis";

import {
  cloneAnyMap,
  contentToText,
  defaultStringValue,
  jsonResponse,
  numberFromAny,
  randomId,
  stringValue,
} from "#providers/lib/helpers.ts";
import {
  anySlice,
  defaultAny,
  type Json,
  mapSlice,
  randomUuid,
  sanitizedToolName,
} from "#providers/providers/antigravity/config.ts";
import {
  buildToolSchemaMap,
  geminiSseToOpenAiStream,
  geminiStreamToOpenAiCompletionImpl,
  geminiToOpenAiCompletion,
  geminiTools,
  peekRetiredNotice,
  retiredResponse,
  sanitizeAntigravityClaudeToolSchema,
  sanitizeToolSchemaKeys,
  unwrapGeminiResponse,
  wrapCodeAssistPayload,
} from "#providers/providers/antigravity/transform.ts";
export type { ToolSchemaMap } from "#providers/providers/antigravity/transform.ts";
import { convertImageURLsToBase64 } from "#providers/lib/images.ts";
import type { UpstreamTransport } from "#providers/api/http.ts";
import type {
  CredentialRefresher,
  Provider,
  ProviderAccount,
  ProviderRequest,
  RefreshedCredentials,
  RefreshBufferProvider,
} from "#providers/model/types.ts";

import { ANTIGRAVITY_GOOGLE_OAUTH_TOKEN_ENDPOINT } from "#providers/api/endpoints.ts";

const GOOGLE_OAUTH_TOKEN_ENDPOINT = ANTIGRAVITY_GOOGLE_OAUTH_TOKEN_ENDPOINT;
const MIN_THINKING_BUDGET = 1024;
const DEFAULT_MAX_OUTPUT_TOKENS = 64000;
const SIGNATURE_CACHE_PREFIX = "opendum:thought-signature";
const SIGNATURE_CACHE_TTL_SECONDS = 24 * 60 * 60;
const CLAUDE_BETA_HEADER = "interleaved-thinking-2025-05-14";
const ANTIGRAVITY_SYSTEM_INSTRUCTION =
  "You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.**Absolute paths only****Proactiveness**";
const TOOL_ARTIFACT_MARKER = /^\s*(Tool:\s*\w+|(?:thought|think)\s*:)/i;

function lastModelSegment(model: string): string {
  const parts = model.split("/");
  return parts[parts.length - 1];
}

function boolValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function numberAsFloat(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function toNumericSessionId(sessionId: string): string {
  const value = sessionId.trim();
  if (!value) return "";
  if (/^-?\d+$/.test(value)) return value;
  const hash = createHash("sha256").update(value).digest();
  const n = hash.readBigUInt64BE(0) & 0x7fffffffffffffffn;
  return `-${n.toString()}`;
}

function stableSessionId(body: Json): string {
  const messages = anySlice(body.messages);
  for (const raw of messages) {
    const msg = (raw ?? {}) as Json;
    if (stringValue(msg.role) !== "user") continue;
    const text = contentToText(msg.content);
    if (!text.trim()) continue;
    const hex = createHash("sha256").update(text).digest("hex").slice(0, 32);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return randomId("session");
}

function isGemini3ModelName(model: string): boolean {
  return lastModelSegment(model).toLowerCase().startsWith("gemini-3");
}

function isTieredGemini3Model(model: string): boolean {
  const value = lastModelSegment(model).toLowerCase();
  return value.startsWith("gemini-3") && value.endsWith("-tiered");
}

function geminiThinkingLevelFromModel(model: string): string {
  const value = lastModelSegment(model).toLowerCase();
  for (const level of ["minimal", "low", "medium", "high"]) {
    if (value.endsWith(`-${level}`)) return level;
  }
  return "";
}

function trimGeminiThinkingLevelSuffix(model: string): string {
  for (const suffix of ["-minimal", "-low", "-medium", "-high"]) {
    if (model.toLowerCase().endsWith(suffix)) return model.slice(0, model.length - suffix.length);
  }
  return model;
}

function defaultThinkingBudget(effort: string): number {
  switch (effort) {
    case "low":
      return 1024;
    case "medium":
      return 10000;
    case "high":
    case "xhigh":
      return 32000;
    default:
      return 0;
  }
}

function codeAssistMetadata(): Json {
  return { ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" };
}

function normalizeGoogleTierId(id: string): string {
  return id.trim().toLowerCase();
}

function isPaidGoogleTierId(id: string): boolean {
  const lower = normalizeGoogleTierId(id);
  return lower === "paid" || lower === "standard-tier";
}

const ANTIGRAVITY_CLAUDE_FLAGS = new Set([
  "anthropic_beta",
  "anthropic_beta_thinking",
  "convert_external_images",
  "force_stream_non_stream",
  "sanitize_tool_blocks",
  "strict_thought_signatures",
  "strict_tool_schema",
  "system_instruction",
  "thinking_model",
  "top_p_min_095",
]);

const GEMINI_THINKING_LEVELS: Json = {
  high: "high",
  low: "low",
  medium: "medium",
  none: "minimal",
  xhigh: "high",
};

const GEMINI_FLASH_THINKING_BUDGETS: Json = { high: 24576, low: 6144, medium: 12288, xhigh: 24576 };
const GEMINI_PRO_THINKING_BUDGETS: Json = { high: 32768, low: 8192, medium: 16384, xhigh: 32768 };

function normalizeAntigravityTieredModel(model: string): string {
  const value = model.trim().toLowerCase();
  for (const suffix of ["-minimal", "-low", "-medium", "-high"]) {
    if (value.endsWith(suffix)) return value.slice(0, -suffix.length);
  }
  return value;
}

// Antigravity request shaping is fixed per model family, so it is derived from
// the model name rather than stored in the registry. Registry values still win
// when an authored model config provides them.
function antigravityConfigValue(model: string, key: string): { found: boolean; value: unknown } {
  const name = normalizeAntigravityTieredModel(model);
  if (name.startsWith("gemini-")) {
    const image = name.includes("image");
    const pro = name.includes("pro");
    const levelThinking = name.startsWith("gemini-3") && !pro && !image;
    switch (key) {
      case "inject_thought_signature":
      case "scrub_model_artifacts":
        return { found: true, value: true };
      case "signature_family":
        return { found: true, value: "gemini-flash" };
      case "system_instruction":
        return { found: true, value: name.startsWith("gemini-3") && !image };
      case "thinking_format":
        if (image) return { found: false, value: undefined };
        return { found: true, value: levelThinking ? "level" : "budget" };
      case "thinking_levels":
        return levelThinking ? { found: true, value: GEMINI_THINKING_LEVELS } : { found: false, value: undefined };
      case "thinking_budgets":
        if (image || levelThinking) return { found: false, value: undefined };
        return { found: true, value: pro ? GEMINI_PRO_THINKING_BUDGETS : GEMINI_FLASH_THINKING_BUDGETS };
      default:
        return { found: false, value: undefined };
    }
  }
  if (name.startsWith("claude-")) {
    if (ANTIGRAVITY_CLAUDE_FLAGS.has(key)) return { found: true, value: true };
    if (key === "signature_family") return { found: true, value: "claude" };
  }
  return { found: false, value: undefined };
}

export type AntigravityOptions = {
  registry: Registry;
  transport: UpstreamTransport;
  redis?: OpendumRedis | null;
  persistAccountInfo?: (accountId: string, info: { projectId: string; tier: string; email: string }) => void;
};

type AccountInfo = { projectId: string; tier: string; paidTier: string; email: string };

function inferMimeTypeFromUrl(value: string): string {
  let path: string;
  try {
    path = new URL(value).pathname;
  } catch {
    path = value;
  }
  const ext = path.toLowerCase().split(".").pop() ?? "";
  const table: Record<string, string> = {
    png: "image/png", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp",
    ico: "image/x-icon", tiff: "image/tiff", tif: "image/tiff", pdf: "application/pdf",
    mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", avi: "video/x-msvideo",
    mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg",
  };
  return table[ext] ?? "image/jpeg";
}

function dataUriToGeminiPart(value: string): Json | null {
  if (!value.startsWith("data:")) return null;
  const comma = value.indexOf(",");
  if (comma === -1) return null;
  const meta = value.slice("data:".length, comma);
  const mimeType = meta.split(";")[0] || "image/png";
  return { inlineData: { mimeType, data: value.slice(comma + 1) } };
}

export class AntigravityProvider implements Provider, CredentialRefresher, RefreshBufferProvider {
  readonly name = "antigravity";
  private readonly registry: Registry;
  private readonly transport: UpstreamTransport;
  private readonly redis: OpendumRedis | null;
  private readonly persistAccountInfo:
    | ((accountId: string, info: { projectId: string; tier: string; email: string }) => void)
    | undefined;
  private readonly clientId = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
  private readonly clientSecret = "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";
  private readonly endpoints = [
    "https://daily-cloudcode-pa.googleapis.com",
    "https://autopush-cloudcode-pa.sandbox.googleapis.com",
    "https://cloudcode-pa.googleapis.com",
  ];
  private readonly loadEndpoints = [
    "https://cloudcode-pa.googleapis.com",
    "https://daily-cloudcode-pa.googleapis.com",
  ];
  private readonly onboardEndpoints = [
    "https://daily-cloudcode-pa.googleapis.com",
    "https://cloudcode-pa.googleapis.com",
  ];
  private readonly defaultProject = "rising-fact-p41fc";
  private readonly userAgent = `antigravity/2.19.1 ${process.platform}/${process.arch}`;
  private readonly apiClient = "google-cloud-sdk vscode_cloudshelleditor/0.1";
  private readonly clientMetadata =
    '{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}';

  constructor(options: AntigravityOptions) {
    this.registry = options.registry;
    this.transport = options.transport;
    this.redis = options.redis ?? null;
    this.persistAccountInfo = options.persistAccountInfo;
  }

  refreshBuffer(): number {
    return 60 * 60 * 1000;
  }

  async refreshCredentials(refreshToken: string, _account: ProviderAccount): Promise<RefreshedCredentials> {
    const form = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: refreshToken.trim(),
      grant_type: "refresh_token",
    });
    const resp = await this.transport.direct(GOOGLE_OAUTH_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const text = await resp.text();
    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(`antigravity token refresh failed: ${resp.status} ${text.slice(0, 1024)}`);
    }
    const token = JSON.parse(text) as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!token.access_token) throw new Error("antigravity token refresh returned empty access token");
    const nextRefresh = token.refresh_token || refreshToken;
    const expiresIn = token.expires_in && token.expires_in > 0 ? token.expires_in : 3600;
    const info = await this.fetchAccountInfo(token.access_token);
    return {
      accessToken: token.access_token,
      refreshToken: nextRefresh,
      expiresAt: new Date(Date.now() + expiresIn * 1000),
      projectId: info.projectId,
      tier: info.tier,
      paidTier: info.paidTier,
      email: info.email,
    };
  }

  private setGoogleHeaders(headers: Record<string, string>, accessToken: string, stream: boolean): void {
    headers.Authorization = `Bearer ${accessToken.trim()}`;
    headers["Content-Type"] = "application/json";
    headers.Accept = stream ? "text/event-stream" : "application/json";
    if (this.userAgent) headers["User-Agent"] = this.userAgent;
    if (this.apiClient) headers["X-Goog-Api-Client"] = this.apiClient;
    if (this.clientMetadata) headers["Client-Metadata"] = this.clientMetadata;
  }

  private async fetchAccountInfo(accessToken: string): Promise<AccountInfo> {
    const info: AccountInfo = { projectId: "", tier: "free-tier", paidTier: "", email: "" };
    let currentTierPresent = false;
    let allowedTiers: Json[] = [];
    let hadError = false;
    for (const endpoint of this.loadEndpoints) {
      const headers: Record<string, string> = {};
      this.setGoogleHeaders(headers, accessToken, false);
      let resp: Response;
      try {
        resp = await this.transport.direct(`${endpoint}/v1internal:loadCodeAssist`, {
          method: "POST",
          headers,
          body: JSON.stringify({ metadata: codeAssistMetadata() }),
        });
      } catch {
        hadError = true;
        continue;
      }
      let data: Json = {};
      if (resp.status >= 200 && resp.status < 300) {
        try {
          data = (await resp.json()) as Json;
        } catch {
          data = {};
        }
      } else {
        hadError = true;
      }
      if (Object.keys(data).length === 0) continue;
      const project = extractGoogleProjectId(data);
      if (project) info.projectId = project;
      if (data.currentTier !== undefined) currentTierPresent = true;
      const currentTierId = extractGoogleTier(data);
      if (currentTierId) info.tier = currentTierId;
      const tiers = extractAllowedTiers(data);
      if (tiers.length > 0) allowedTiers = tiers;
      if (!currentTierId) {
        const tier = detectAntigravityTier(data);
        if (tier) info.tier = tier;
      }
      const paidTier = extractPaidGoogleTier(data);
      if (paidTier) info.paidTier = paidTier;
      if (info.projectId) break;
    }
    if (!info.projectId && !currentTierPresent) {
      const onboard = await this.onboardUser(accessToken, info.tier, allowedTiers);
      if (onboard.projectId) {
        info.projectId = onboard.projectId;
        info.tier = onboard.tier;
      }
    }
    if (info.projectId === "" && hadError) info.projectId = this.defaultProject;
    info.email = await this.fetchGoogleEmail(accessToken);
    return info;
  }

  private async onboardUser(
    accessToken: string,
    tier: string,
    allowedTiers: Json[]
  ): Promise<AccountInfo> {
    if (allowedTiers.length === 0) return { projectId: "", tier: "", paidTier: "", email: "" };
    const onboardTier = selectOnboardTier(tier, allowedTiers);
    if (!onboardTier) return { projectId: "", tier: "", paidTier: "", email: "" };
    const payload = JSON.stringify({ tierId: onboardTier, metadata: codeAssistMetadata() });
    for (const endpoint of this.onboardEndpoints) {
      let data = await this.postOnboardUser(accessToken, endpoint, payload);
      if (!data) continue;
      for (let i = 0; i < 30 && data.done === false; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const polled = await this.postOnboardUser(accessToken, endpoint, payload);
        if (polled) data = polled;
      }
      if (data.done === false) continue;
      const response = data.response;
      if (response !== null && typeof response === "object" && !Array.isArray(response)) data = response as Json;
      const project = extractGoogleProjectId(data);
      if (project) return { projectId: project, tier: normalizeGoogleTierId(onboardTier), paidTier: "", email: "" };
    }
    return { projectId: "", tier: "", paidTier: "", email: "" };
  }

  private async postOnboardUser(accessToken: string, endpoint: string, payload: string): Promise<Json | null> {
    const headers: Record<string, string> = {};
    this.setGoogleHeaders(headers, accessToken, false);
    try {
      const resp = await this.transport.direct(`${endpoint}/v1internal:onboardUser`, {
        method: "POST",
        headers,
        body: payload,
      });
      if (resp.status < 200 || resp.status >= 300) return null;
      return (await resp.json()) as Json;
    } catch {
      return null;
    }
  }

  private async fetchGoogleEmail(accessToken: string): Promise<string> {
    const headers: Record<string, string> = {};
    this.setGoogleHeaders(headers, accessToken, false);
    try {
      const resp = await this.transport.direct("https://www.googleapis.com/oauth2/v2/userinfo", { headers });
      if (resp.status < 200 || resp.status >= 300) return "";
      const data = (await resp.json()) as Json;
      return stringValue(data.email);
    } catch {
      return "";
    }
  }

  async makeRequest(request: ProviderRequest): Promise<Response> {
    const body = request.body;
    let projectId = request.account.projectId?.trim() ?? "";
    if (!projectId) projectId = this.defaultProject;
    if (!projectId) {
      const info = await this.fetchAccountInfo(request.credentials);
      projectId = info.projectId || this.defaultProject;
      if (projectId && request.account.id) {
        const tier = info.paidTier || info.tier;
        this.persistAccountInfo?.(request.account.id, { projectId, tier, email: info.email });
      }
    }
    if (!projectId) throw new Error("antigravity account missing projectId");

    let modelName = this.resolveModel(stringValue(body.model));
    modelName = this.resolveAntigravityGemini3ModelVariant(modelName, body);
    let normalizedBody = this.normalizeBodyForModel(body, modelName);
    const messages = normalizedBody.messages;
    if (Array.isArray(messages) && modelName.includes("claude")) {
      normalizedBody = cloneAnyMap(normalizedBody);
      normalizedBody.messages = await convertImageURLsToBase64(this.transport.direct, messages);
    }

    const clientSession = stringValue(normalizedBody._sessionId);
    let sessionId = clientSession ? toNumericSessionId(clientSession) : toNumericSessionId(stableSessionId(normalizedBody));
    if (!sessionId) sessionId = toNumericSessionId(randomUuid());

    const geminiPayload = openAiToGemini(normalizedBody);
    await this.transformAntigravityPayload(geminiPayload, modelName, sessionId);
    const toolSchemas = buildToolSchemaMap(geminiPayload.tools);
    if (!this.configBool(modelName, "strict_tool_schema")) sanitizeToolSchemaKeys(toolSchemas);

    const requestPayload = wrapCodeAssistPayload(projectId, modelName, geminiPayload);
    let actualStream = request.stream;
    if (!modelName.includes("gemini") && !request.stream) actualStream = true;
    else if (this.configBool(modelName, "force_stream_non_stream") && !request.stream) actualStream = true;
    const action = actualStream ? "streamGenerateContent?alt=sse" : "generateContent";
    const encoded = JSON.stringify(requestPayload);

    let lastResp: Response | null = null;
    let lastErr: unknown = null;
    for (const endpoint of this.endpoints) {
      const headers: Record<string, string> = {};
      this.setGoogleHeaders(headers, request.credentials, actualStream);
      if (this.shouldSetAnthropicBeta(modelName)) headers["anthropic-beta"] = CLAUDE_BETA_HEADER;
      let resp: Response;
      try {
        resp = await this.transport.direct(`${endpoint}/v1internal:${action}`, {
          method: "POST",
          headers,
          body: encoded,
        });
      } catch (error) {
        lastErr = error;
        continue;
      }
      if (resp.status === 429) {
        request.onUpstreamResponseStart?.();
        return resp;
      }
      if ([401, 403, 404].includes(resp.status) || resp.status >= 500) {
        lastResp = resp;
        continue;
      }
      if (resp.status < 200 || resp.status >= 300) {
        request.onUpstreamResponseStart?.();
        return resp;
      }
      request.onUpstreamResponseStart?.();
      lastResp = resp;
      lastErr = null;
      break;
    }
    const resp = lastResp;
    if (lastErr || !resp || resp.status < 200 || resp.status >= 300) {
      if (lastErr) throw lastErr;
      return resp as Response;
    }

    let streamBody: ReadableStream<Uint8Array> | null = resp.body;
    if (request.stream || actualStream) {
      const { retired, notice, body } = await peekRetiredNotice(resp);
      if (retired) return retiredResponse(notice);
      streamBody = body ?? resp.body;
    }
    if (!streamBody) throw new Error("antigravity response stream is empty");

    if (request.stream) {
      return new Response(geminiSseToOpenAiStream(this, streamBody, modelName, sessionId, toolSchemas), {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }
    if (actualStream) {
      const completion = await geminiStreamToOpenAiCompletionImpl(this, streamBody, modelName, sessionId, toolSchemas);
      return jsonResponse(200, completion);
    }
    const data = (await resp.json()) as unknown;
    const response = unwrapGeminiResponse(data);
    this.cacheSignaturesFromResponse(response, modelName, sessionId);
    return jsonResponse(200, geminiToOpenAiCompletion(response, modelName, toolSchemas));
  }

  private configValue(model: string, key: string): unknown {
    const cfg = this.registry.providerModelConfig(model, this.name);
    if (cfg) {
      if (key in cfg) return cfg[key];
      const custom = cfg.custom;
      if (custom && typeof custom === "object" && key in custom) return custom[key];
    }
    const derived = antigravityConfigValue(model, key);
    return derived.found ? derived.value : undefined;
  }

  private configBool(model: string, key: string): boolean {
    return this.configValue(model, key) === true;
  }

  private configString(model: string, key: string): string {
    const value = this.configValue(model, key);
    return typeof value === "string" ? value.trim() : "";
  }

  private configStringMap(model: string, key: string): Record<string, string> {
    const value = this.configValue(model, key);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
    const out: Record<string, string> = {};
    for (const [entryKey, entryValue] of Object.entries(value as Json)) {
      if (typeof entryValue === "string" && entryValue.trim()) out[entryKey] = entryValue.trim();
    }
    return out;
  }

  private configIntMap(model: string, key: string): Record<string, number> {
    const value = this.configValue(model, key);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
    const out: Record<string, number> = {};
    for (const [entryKey, entryValue] of Object.entries(value as Json)) {
      const num = numberFromAny(entryValue);
      if (num !== 0) out[entryKey] = num;
    }
    return out;
  }

  private resolveModel(model: string): string {
    let value = lastModelSegment(model);
    if (value.endsWith(":thinking")) value = value.slice(0, -":thinking".length);
    return this.registry.upstreamModelName(value, this.name);
  }

  private resolveAntigravityGemini3ModelVariant(model: string, body: Json): string {
    if (!isGemini3ModelName(model)) return model;
    const lower = model.toLowerCase();
    if (lower.startsWith("gemini-3.5-flash") && !lower.includes("lite")) {
      const base = trimGeminiThinkingLevelSuffix(model);
      let level = geminiThinkingLevelFromModel(model);
      const bodyLevel = this.requestedGemini3ThinkingLevel(model, body);
      if (bodyLevel) level = bodyLevel;
      if (!level) level = "medium";
      return `${base}-${level}`;
    }
    if (!model.toLowerCase().includes("pro")) return model;
    const base = trimGeminiThinkingLevelSuffix(model);
    let level = geminiThinkingLevelFromModel(model);
    const bodyLevel = this.requestedGemini3ThinkingLevel(model, body);
    if (bodyLevel) level = bodyLevel;
    if (!level) level = "high";
    return `${base}-${level}`;
  }

  private requestedGemini3ThinkingLevel(model: string, body: Json): string {
    const thinking = body.thinking;
    if (thinking !== null && typeof thinking === "object" && !Array.isArray(thinking)) {
      const t = thinking as Json;
      const level = this.normalizeGemini3ThinkingLevel(model, stringValue(t.thinkingLevel));
      if (level) return level;
      const budget = numberFromAny(t.budget_tokens);
      if (budget > 0) return this.thinkingLevelFromBudget(model, budget);
    }
    const bodyBudget = numberFromAny(body.thinking_budget);
    if (bodyBudget > 0) return this.thinkingLevelFromBudget(model, bodyBudget);
    const effort = stringValue(body.reasoning_effort);
    if (effort) {
      const level = this.thinkingLevelFromEffort(model, effort);
      if (level) return level;
    }
    const reasoning = body.reasoning;
    if (reasoning !== null && typeof reasoning === "object" && !Array.isArray(reasoning)) {
      const rEffort = stringValue((reasoning as Json).effort);
      if (rEffort) {
        const level = this.thinkingLevelFromEffort(model, rEffort);
        if (level) return level;
      }
    }
    return "";
  }

  private normalizeBodyForModel(body: Json, model: string): Json {
    const out = cloneAnyMap(body);
    delete out.logit_bias;
    if (this.configBool(model, "top_p_min_095")) {
      const topP = numberAsFloat(out.top_p);
      if (topP !== null && topP < 0.95) delete out.top_p;
    }
    return out;
  }

  private shouldSetAnthropicBeta(model: string): boolean {
    if (this.configBool(model, "anthropic_beta")) return true;
    return model.includes("claude") && model.includes("thinking");
  }

  private thinkingLevel(model: string, effort: string): string {
    const levels = this.configStringMap(model, "thinking_levels");
    if (Object.keys(levels).length === 0) return "";
    return levels[effort] || levels.high || "";
  }

  private thinkingLevelFromBudget(model: string, budget: number): string {
    let effort = "high";
    const budgets = this.configIntMap(model, "thinking_budgets");
    const low = budgets.low ?? 0;
    const medium = budgets.medium ?? 0;
    if (low > 0 && budget <= low) effort = "low";
    else if (medium > 0 && budget <= medium) effort = "medium";
    else if (Object.keys(budgets).length === 0) {
      if (budget <= 8192) effort = "low";
      else if (budget <= 16384) effort = "medium";
    }
    const level = this.thinkingLevel(model, effort);
    return this.normalizeGemini3ThinkingLevel(model, level || effort);
  }

  private thinkingLevelFromEffort(model: string, effort: string): string {
    const level = this.thinkingLevel(model, effort);
    return this.normalizeGemini3ThinkingLevel(model, level || effort);
  }

  private normalizeGemini3ThinkingLevel(model: string, level: string): string {
    const value = level.trim().toLowerCase();
    switch (value) {
      case "xhigh":
        return "high";
      case "minimal":
        return model.toLowerCase().includes("pro") ? "low" : "minimal";
      case "medium": {
        const lower = model.toLowerCase();
        if (lower.includes("pro") && !lower.includes("gemini-3.1-pro")) return "high";
        return "medium";
      }
      case "low":
      case "high":
        return value;
      default:
        return "";
    }
  }

  private fitGemini3ThinkingLevel(generation: Json, model: string, level: string): string {
    const maxTokens = numberFromAny(defaultAny(generation.maxOutputTokens, generation.max_output_tokens));
    if (maxTokens <= 0) return level;
    const budgets = this.configIntMap(model, "thinking_budgets");
    if (Object.keys(budgets).length === 0) return level;
    for (const candidate of ["minimal", "low", "medium", "high", "xhigh"]) {
      const budget = budgets[candidate] ?? 0;
      if (budget <= 0 || budget > maxTokens / 2) continue;
      const normalized = this.normalizeGemini3ThinkingLevel(model, candidate);
      return normalized || candidate;
    }
    return "";
  }

  private normalizeGemini3ThinkingConfig(thinking: Json | null, model: string): Json | null {
    const out: Json = {};
    const include = defaultAny(thinking?.includeThoughts, thinking?.include_thoughts);
    if (typeof include === "boolean") out.includeThoughts = include;
    let level = defaultStringValue(thinking?.thinkingLevel, stringValue(thinking?.thinking_level));
    if (!level) {
      const budget = numberFromAny(defaultAny(thinking?.thinkingBudget, thinking?.thinking_budget));
      if (budget > 0) level = this.thinkingLevelFromBudget(model, budget);
    } else {
      level = this.normalizeGemini3ThinkingLevel(model, level);
    }
    if (!level) level = geminiThinkingLevelFromModel(model);
    if (!level && lastModelSegment(model).toLowerCase().endsWith("-tiered")) level = "medium";
    if (level) {
      out.thinkingLevel = level;
      if (out.includeThoughts === undefined) out.includeThoughts = true;
    }
    return Object.keys(out).length === 0 ? null : out;
  }

  private applyThinkingConfig(payload: Json, model: string, effort: string, budget: number): void {
    const config: Json = {};
    if (isGemini3ModelName(model)) {
      let level = "";
      if (budget > 0) level = this.thinkingLevelFromBudget(model, budget);
      else if (effort && effort !== "none") level = this.thinkingLevelFromEffort(model, effort);
      if (level) {
        config.thinkingLevel = level;
        config.includeThoughts = true;
      }
    } else {
      let format = this.configString(model, "thinking_format");
      if (!format) format = "budget";
      if (budget > 0 && format !== "level") {
        config.thinkingBudget = budget;
        config.includeThoughts = true;
      } else if (effort && effort !== "none") {
        if (format === "level") {
          const level = this.thinkingLevel(model, effort);
          if (level) config.thinkingLevel = level;
        } else {
          const budgets = this.configIntMap(model, "thinking_budgets");
          const thinkingBudget = budgets[effort] > 0 ? budgets[effort] : budgets.high || 0;
          if (thinkingBudget > 0) config.thinkingBudget = thinkingBudget;
        }
        config.includeThoughts = true;
      }
    }
    if (Object.keys(config).length === 0) return;
    const generation = (payload.generationConfig ?? {}) as Json;
    generation.thinkingConfig = config;
    payload.generationConfig = generation;
  }

  private normalizeThinkingConfig(payload: Json, model: string): void {
    let generation = payload.generationConfig as Json | undefined;
    if (!generation || typeof generation !== "object") {
      if (this.configBool(model, "thinking_model") || isTieredGemini3Model(model) || isGemini3ModelName(model)) {
        generation = {};
        payload.generationConfig = generation;
      } else {
        return;
      }
    }
    const rawThinking =
      (generation.thinkingConfig as Json | undefined) ?? null;
    if (isGemini3ModelName(model)) {
      const thinking = this.normalizeGemini3ThinkingConfig(rawThinking, model);
      if (thinking) {
        const level = this.fitGemini3ThinkingLevel(generation, model, stringValue(thinking.thinkingLevel));
        if (!level) {
          delete generation.thinkingConfig;
          return;
        }
        thinking.thinkingLevel = level;
        generation.thinkingConfig = thinking;
        const budgets = this.configIntMap(model, "thinking_budgets");
        if ((budgets[level] ?? 0) > 0) {
          const maxTokens = numberFromAny(defaultAny(generation.maxOutputTokens, generation.max_output_tokens));
          if (maxTokens === 0) {
            generation.maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS;
            delete generation.max_output_tokens;
          }
        }
      } else {
        delete generation.thinkingConfig;
      }
      return;
    }
    const thinking = normalizedThinkingMap(rawThinking);
    if (this.configBool(model, "thinking_model")) {
      if (!thinking) {
        delete generation.thinkingConfig;
        if (numberFromAny(defaultAny(generation.maxOutputTokens, generation.max_output_tokens)) === 0) {
          generation.maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS;
          delete generation.max_output_tokens;
        }
        return;
      }
      if (thinking.include_thoughts === undefined && thinking.includeThoughts === undefined) {
        thinking.include_thoughts = true;
      }
      if (thinking.thinkingBudget === undefined && thinking.thinking_budget === undefined) {
        thinking.thinkingBudget = 16384;
      }
      let finalThinking = thinking;
      if (this.configBool(model, "strict_tool_schema")) {
        const strict: Json = {
          include_thoughts: boolValue(
            defaultAny(thinking.include_thoughts, thinking.includeThoughts),
            true
          ),
        };
        const budget = numberFromAny(defaultAny(thinking.thinkingBudget, thinking.thinking_budget));
        if (budget > 0) strict.thinking_budget = budget;
        finalThinking = strict;
      }
      generation.thinkingConfig = finalThinking;
      const budget = numberFromAny(defaultAny(thinking.thinkingBudget, thinking.thinking_budget));
      if (budget > 0) {
        let answer = numberFromAny(defaultAny(generation.maxOutputTokens, generation.max_output_tokens));
        if (answer <= 0) answer = DEFAULT_MAX_OUTPUT_TOKENS;
        let maxTokens = answer + budget;
        const cfg = this.registry.providerModelConfig(model, this.name);
        const limit = cfg?.maxOutputTokens ?? 0;
        if (limit > 0 && maxTokens > limit) maxTokens = limit;
        if (maxTokens <= budget) {
          const clamped = Math.floor(maxTokens / 2);
          if (clamped < MIN_THINKING_BUDGET) {
            delete generation.thinkingConfig;
            return;
          }
          if (finalThinking.thinkingBudget !== undefined) finalThinking.thinkingBudget = clamped;
          if (finalThinking.thinking_budget !== undefined) finalThinking.thinking_budget = clamped;
        }
        generation.maxOutputTokens = maxTokens;
        delete generation.max_output_tokens;
      }
      return;
    }
    if (thinking) generation.thinkingConfig = thinking;
    else delete generation.thinkingConfig;
  }

  private signatureFamily(model: string): string {
    return this.configString(model, "signature_family") || this.configString(model, "transform");
  }

  private signatureCacheKey(model: string, sessionId: string, thoughtText: string): string {
    const hash = createHash("sha256")
      .update(`${this.signatureFamily(model)}:${sessionId}:${thoughtText.trim()}`)
      .digest("hex");
    return `${SIGNATURE_CACHE_PREFIX}:${hash}`;
  }

  async getCachedSignature(model: string, sessionId: string, thoughtText: string): Promise<string> {
    if (!this.redis || !sessionId || !thoughtText.trim()) return "";
    try {
      const raw = await this.redis.get(this.signatureCacheKey(model, sessionId, thoughtText));
      if (!raw) return "";
      const cached = JSON.parse(raw) as Json;
      return stringValue(cached.signature);
    } catch {
      return "";
    }
  }

  async cacheSignature(model: string, sessionId: string, thoughtText: string, signature: string): Promise<void> {
    if (!this.redis || !sessionId || !thoughtText.trim() || !signature.trim()) return;
    try {
      await this.redis.set(
        this.signatureCacheKey(model, sessionId, thoughtText),
        JSON.stringify({ signature }),
        { EX: SIGNATURE_CACHE_TTL_SECONDS }
      );
    } catch {
      return;
    }
  }

  async cacheSignaturesFromResponse(response: Json, model: string, sessionId: string): Promise<void> {
    for (const candidate of anySlice(response.candidates)) {
      const content = ((candidate as Json).content ?? {}) as Json;
      for (const rawPart of anySlice(content.parts)) {
        const part = (rawPart ?? {}) as Json;
        if (part.thought === true) {
          const text = stringValue(part.text);
          const signature = stringValue(part.thoughtSignature);
          if (text && signature) await this.cacheSignature(model, sessionId, text, signature);
        }
      }
    }
  }

  async transformAntigravityPayload(payload: Json, model: string, sessionId: string): Promise<void> {
    delete payload.safetySettings;
    if (payload.system_instruction !== undefined) {
      payload.systemInstruction = payload.system_instruction;
      delete payload.system_instruction;
    }
    normalizeCachedContent(payload);
    delete payload.model;
    ensureToolConfig(payload);
    this.normalizeThinkingConfig(payload, model);
    if (this.configBool(model, "strict_tool_schema")) normalizeClaudeTools(payload);
    else sanitizeGeminiToolNames(payload);
    sortFunctionDeclarations(payload);
    this.applyAntigravitySystemInstruction(payload, model);
    await this.normalizeAntigravityContents(payload, model, sessionId);
    stripTrailingModelTurns(payload);
    payload.sessionId = sessionId;
  }

  private applyAntigravitySystemInstruction(payload: Json, model: string): void {
    let needsInjection = this.configBool(model, "system_instruction");
    if (!needsInjection) {
      if (this.registry.providerModelConfig(model, this.name)) return;
      needsInjection = fallbackAntigravitySystemInstructionModel(model);
    }
    if (!needsInjection) return;
    const parts: unknown[] = [{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION }];
    let existingRecord: Json = {};
    const existing = payload.systemInstruction;
    if (typeof existing === "string" && existing) {
      parts.push({ text: existing });
    } else if (existing !== null && typeof existing === "object" && !Array.isArray(existing)) {
      existingRecord = cloneAnyMap(existing as Json);
      if (Array.isArray((existing as Json).parts)) parts.push(...((existing as Json).parts as unknown[]));
    }
    existingRecord.role = "user";
    existingRecord.parts = parts;
    payload.systemInstruction = existingRecord;
  }

  private async normalizeAntigravityContents(payload: Json, model: string, sessionId: string): Promise<void> {
    const contents = anySlice(payload.contents);
    const strict = this.configBool(model, "strict_tool_schema");
    const functionCallIdQueues: Record<string, string[]> = {};
    for (const rawContent of contents) {
      const content = rawContent as Json;
      if (this.configBool(model, "scrub_model_artifacts") && content.role === "model") {
        scrubConversationArtifacts(content);
      }
      const parts = anySlice(content.parts);
      const filtered: unknown[] = [];
      let currentThoughtSignature = "";
      for (const rawPart of parts) {
        const part = rawPart as Json;
        if (typeof part.text === "string" && part.text === "") continue;
        if (part.thought === true) {
          const thoughtText = stringValue(part.text);
          let signature = stringValue(part.thoughtSignature);
          if (strict) {
            if (!signature || signature.length < 50) {
              const cached = await this.getCachedSignature(model, sessionId, thoughtText);
              if (cached) {
                signature = cached;
                part.thoughtSignature = cached;
              }
            }
            if (signature.length > 50) {
              await this.cacheSignature(model, sessionId, thoughtText, signature);
              currentThoughtSignature = signature;
            } else {
              continue;
            }
          } else {
            const cached = await this.getCachedSignature(model, sessionId, thoughtText);
            if (cached) {
              part.thoughtSignature = cached;
              currentThoughtSignature = cached;
              filtered.push(rawPart);
            }
            continue;
          }
        }
        if (part.functionCall !== undefined && part.functionCall !== null) {
          const fn = part.functionCall as Json;
          const name = stringValue(fn.name);
          if (fn.id === undefined || fn.id === null) fn.id = randomId(name);
          if (strict && name) {
            functionCallIdQueues[name] = functionCallIdQueues[name] ?? [];
            functionCallIdQueues[name].push(stringValue(fn.id));
          }
          if (!strict && this.configBool(model, "inject_thought_signature") && part.thoughtSignature === undefined) {
            part.thoughtSignature = currentThoughtSignature || "skip_thought_signature_validator";
          }
        }
        if (part.functionResponse !== undefined && part.functionResponse !== null) {
          const fn = part.functionResponse as Json;
          if (fn.id === undefined || fn.id === null) {
            const name = stringValue(fn.name);
            if (strict && functionCallIdQueues[name] && functionCallIdQueues[name].length > 0) {
              fn.id = functionCallIdQueues[name].shift();
            } else {
              fn.id = randomId(name);
            }
          }
        }
        if (!strict && part.thoughtSignature !== undefined && part.functionCall === undefined) {
          delete part.thoughtSignature;
        }
        filtered.push(rawPart);
      }
      content.parts = filtered;
    }
    if (strict || this.configBool(model, "sanitize_tool_blocks")) {
      payload.contents = sanitizeToolBlocks(contents);
      return;
    }
    const kept: unknown[] = [];
    for (const rawContent of contents) {
      const content = rawContent as Json;
      if (!content) continue;
      if (anySlice(content.parts).length === 0) continue;
      kept.push(rawContent);
    }
    payload.contents = kept;
  }
}

function normalizedThinkingMap(value: unknown): Json | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Json;
  const out: Json = {};
  const budget = numberFromAny(defaultAny(record.thinkingBudget, record.thinking_budget));
  if (budget > 0) out.thinkingBudget = budget;
  const level = defaultStringValue(record.thinkingLevel, stringValue(record.thinking_level));
  if (level) out.thinkingLevel = level.toLowerCase();
  const include = defaultAny(record.includeThoughts, record.include_thoughts);
  if (typeof include === "boolean") out.include_thoughts = include;
  return Object.keys(out).length === 0 ? null : out;
}

function normalizeCachedContent(payload: Json): void {
  const extra = payload.extra_body;
  if (extra !== null && typeof extra === "object" && !Array.isArray(extra)) {
    const value = defaultStringValue((extra as Json).cached_content, stringValue((extra as Json).cachedContent));
    if (value) payload.cachedContent = value;
    delete (extra as Json).cached_content;
    delete (extra as Json).cachedContent;
    if (Object.keys(extra as Json).length === 0) delete payload.extra_body;
  }
  const value = defaultStringValue(payload.cached_content, stringValue(payload.cachedContent));
  if (value) payload.cachedContent = value;
  delete payload.cached_content;
  delete payload.cachedContent;
}

function stripTrailingModelTurns(payload: Json): void {
  let contents = anySlice(payload.contents);
  while (contents.length > 1) {
    const last = (contents[contents.length - 1] ?? {}) as Json;
    if (last.role !== "model") break;
    contents = contents.slice(0, -1);
  }
  payload.contents = contents;
}

function sortFunctionDeclarations(payload: Json): void {
  for (const rawTool of anySlice(payload.tools)) {
    const tool = rawTool as Json;
    const decls = anySlice(tool.functionDeclarations);
    if (decls.length <= 1) continue;
    decls.sort((a, b) => stringValue((a as Json).name).localeCompare(stringValue((b as Json).name)));
    tool.functionDeclarations = decls;
  }
}

function ensureToolConfig(payload: Json): void {
  let toolConfig = payload.toolConfig as Json | undefined;
  if (!toolConfig || typeof toolConfig !== "object") {
    toolConfig = {};
    payload.toolConfig = toolConfig;
  }
  let calling = toolConfig.functionCallingConfig as Json | undefined;
  if (!calling || typeof calling !== "object") {
    calling = {};
    toolConfig.functionCallingConfig = calling;
  }
  calling.mode = "VALIDATED";
}

function normalizeClaudeTools(payload: Json): void {
  for (const rawTool of anySlice(payload.tools)) {
    const tool = rawTool as Json;
    for (const rawDecl of anySlice(tool.functionDeclarations)) {
      const decl = rawDecl as Json;
      if (decl.parametersJsonSchema !== undefined) {
        decl.parameters = decl.parametersJsonSchema;
        delete decl.parametersJsonSchema;
      }
      let params = decl.parameters as Json | undefined;
      if (!params || typeof params !== "object") params = { type: "object", properties: {} };
      params = sanitizeAntigravityClaudeToolSchema(params);
      if (params.type === undefined) params.type = "object";
      if (params.properties === undefined) params.properties = {};
      if (params.required === undefined) params.required = [];
      decl.parameters = params;
    }
  }
}

function sanitizeGeminiToolNames(payload: Json): void {
  for (const rawTool of anySlice(payload.tools)) {
    const tool = rawTool as Json;
    for (const rawDecl of anySlice(tool.functionDeclarations)) {
      const decl = rawDecl as Json;
      decl.name = sanitizedToolName(stringValue(decl.name));
    }
  }
}

function scrubConversationArtifacts(content: Json): void {
  for (const rawPart of anySlice(content.parts)) {
    const part = rawPart as Json;
    const text = stringValue(part.text);
    if (!text) continue;
    part.text = scrubToolTranscriptArtifacts(text);
  }
}

function scrubToolTranscriptArtifacts(text: string): string {
  const lines = text.split("\n");
  const output: string[] = [];
  let inFence = false;
  let fenceStart = "";
  let fenceLines: string[] = [];
  const flushFence = (end: string): void => {
    const cleaned: string[] = [];
    let hadMarker = false;
    for (const line of fenceLines) {
      if (TOOL_ARTIFACT_MARKER.test(line)) {
        hadMarker = true;
        continue;
      }
      cleaned.push(line);
    }
    const hasContent = cleaned.some((line) => line.trim() !== "");
    if (!hadMarker || hasContent) {
      output.push(fenceStart, ...cleaned, end);
    }
  };
  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      if (!inFence) {
        inFence = true;
        fenceStart = line;
        fenceLines = [];
        continue;
      }
      flushFence(line);
      inFence = false;
      continue;
    }
    if (inFence) {
      fenceLines.push(line);
      continue;
    }
    if (TOOL_ARTIFACT_MARKER.test(line)) continue;
    output.push(line);
  }
  if (inFence) output.push(fenceStart, ...fenceLines);
  let cleaned = output.join("\n");
  while (cleaned.includes("\n\n\n\n")) cleaned = cleaned.replace(/\n\n\n\n/g, "\n\n\n");
  return cleaned;
}

function sanitizeToolBlocks(contents: unknown[]): unknown[] {
  const callIds = new Set<string>();
  const responseIds = new Set<string>();
  for (const rawContent of contents) {
    const content = rawContent as Json;
    for (const rawPart of anySlice(content.parts)) {
      const part = rawPart as Json;
      if (part.functionCall !== undefined) {
        const id = stringValue((part.functionCall as Json).id);
        if (id) callIds.add(id);
      }
      if (part.functionResponse !== undefined) {
        const id = stringValue((part.functionResponse as Json).id);
        if (id) responseIds.add(id);
      }
    }
  }
  const out: unknown[] = [];
  for (const rawContent of contents) {
    const content = rawContent as Json;
    const parts: unknown[] = [];
    for (const rawPart of anySlice(content.parts)) {
      const part = rawPart as Json;
      if (part.functionCall !== undefined && !responseIds.has(stringValue((part.functionCall as Json).id))) continue;
      if (part.functionResponse !== undefined && !callIds.has(stringValue((part.functionResponse as Json).id))) continue;
      parts.push(rawPart);
    }
    if (parts.length > 0) {
      const copyContent = cloneAnyMap(content);
      copyContent.parts = parts;
      out.push(copyContent);
    }
  }
  return out;
}

function extractGoogleProjectId(data: Json): string {
  const value = stringValue(data.cloudaicompanionProject);
  if (value) return value;
  const project = data.cloudaicompanionProject;
  if (project !== null && typeof project === "object" && !Array.isArray(project)) {
    return stringValue((project as Json).id);
  }
  return "";
}

function extractGoogleTier(data: Json): string {
  const value = stringValue(data.currentTier);
  if (value) return normalizeGoogleTierId(value);
  const tier = data.currentTier;
  if (tier !== null && typeof tier === "object" && !Array.isArray(tier)) {
    const id = stringValue((tier as Json).id);
    if (id) return normalizeGoogleTierId(id);
    return normalizeGoogleTierId(stringValue((tier as Json).name));
  }
  return "";
}

function extractPaidGoogleTier(data: Json): string {
  const paidTier = data.paidTier;
  if (paidTier === null || typeof paidTier !== "object" || Array.isArray(paidTier)) return "";
  const id = normalizeGoogleTierId(stringValue((paidTier as Json).id));
  return id && id !== "free-tier" ? id : "";
}

function extractAllowedTiers(data: Json): Json[] {
  return mapSlice(data.allowedTiers);
}

function detectAntigravityTier(data: Json): string {
  let detected = "";
  for (const tier of extractAllowedTiers(data)) {
    if (tier.isDefault === true) {
      detected = normalizeGoogleTierId(stringValue(tier.id));
      break;
    }
  }
  const paidTier = data.paidTier;
  if (paidTier !== null && typeof paidTier === "object" && !Array.isArray(paidTier)) {
    const id = normalizeGoogleTierId(stringValue((paidTier as Json).id));
    if (id && isPaidGoogleTierId(id)) return id;
  }
  return detected;
}

function selectOnboardTier(fallback: string, allowedTiers: Json[]): string {
  for (const tier of allowedTiers) {
    if (tier.isDefault === true) {
      const id = stringValue(tier.id);
      if (id) return id;
    }
  }
  for (const tier of allowedTiers) {
    if (stringValue(tier.id) === "legacy-tier") return "legacy-tier";
  }
  if (allowedTiers.length > 0) return stringValue(allowedTiers[0].id);
  return fallback || "free-tier";
}

function fallbackAntigravitySystemInstructionModel(model: string): boolean {
  const normalized = lastModelSegment(model).toLowerCase();
  if (normalized.includes("image")) return false;
  return normalized.includes("claude") || isGemini3ModelName(normalized);
}

function openAiToGemini(body: Json): Json {
  const messages = anySlice(body.messages);
  let contents: unknown[] = [];
  const systemParts: unknown[] = [];
  const completed = completedToolCallIds(messages);
  const toolUseIds = toolUseIdSet(messages);
  const validToolResultIds = validToolResultIdSet(messages);
  const toolCallFunctionNames = toolCallFunctionNameMap(messages);
  for (const raw of messages) {
    const msg = (raw ?? {}) as Json;
    const role = stringValue(msg.role);
    if (role === "system" || role === "developer") {
      systemParts.push(...openAiContentTextParts(msg.content));
      continue;
    }
    let parts = openAiContentToGeminiParts(msg.content);
    parts = [...parts, ...openAiToolCallsToGeminiParts(msg, completed)];
    if (role === "tool") {
      const toolCallId = stringValue(msg.tool_call_id);
      if (!toolCallId || !validToolResultIds.has(toolCallId) || !toolUseIds.has(toolCallId)) continue;
      let functionName = stringValue(msg.name);
      if (!functionName) functionName = toolCallFunctionNames[toolCallId] ?? "";
      if (!functionName) functionName = "unknown";
      parts = [
        {
          functionResponse: {
            name: functionName,
            id: toolCallId,
            response: { result: msg.content },
          },
        },
      ];
    }
    const geminiRole = role === "assistant" ? "model" : "user";
    if (parts.length > 0) contents.push({ role: geminiRole, parts });
  }
  contents = separateTextAndToolParts(groupConsecutiveToolResponses(sanitizeGeminiContents(contents)));
  const payload: Json = { contents };
  if (systemParts.length > 0) payload.systemInstruction = { parts: systemParts };
  const generation: Json = {};
  if (body.temperature !== undefined && body.temperature !== null) generation.temperature = body.temperature;
  if (body.top_p !== undefined && body.top_p !== null) generation.topP = body.top_p;
  if (body.max_tokens !== undefined && body.max_tokens !== null) generation.maxOutputTokens = body.max_tokens;
  if (body.stop !== undefined && body.stop !== null) {
    if (Array.isArray(body.stop)) generation.stopSequences = body.stop;
    else if (stringValue(body.stop)) generation.stopSequences = [body.stop];
  }
  const thinking = requestThinkingConfig(body);
  if (Object.keys(thinking).length > 0) generation.thinkingConfig = thinking;
  if (Object.keys(generation).length > 0) payload.generationConfig = generation;
  const tools = geminiTools(body.tools);
  if (tools.length > 0) payload.tools = [{ functionDeclarations: tools }];
  for (const key of ["cached_content", "cachedContent", "extra_body", "system_instruction"]) {
    if (body[key] !== undefined && body[key] !== null) payload[key] = body[key];
  }
  payload.safetySettings = [
    { category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" },
    { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "OFF" },
    { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "OFF" },
    { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "OFF" },
  ];
  return payload;
}

function openAiContentTextParts(content: unknown): unknown[] {
  if (typeof content === "string") return [{ text: content }];
  const parts: unknown[] = [];
  for (const raw of anySlice(content)) {
    const item = (raw ?? {}) as Json;
    if (item.type !== "text") continue;
    const text = stringValue(item.text);
    if (text) parts.push({ text });
  }
  return parts;
}

function completedToolCallIds(messages: unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const raw of messages) {
    const msg = (raw ?? {}) as Json;
    if (stringValue(msg.role) === "tool") {
      const id = stringValue(msg.tool_call_id);
      if (id) ids.add(id);
    }
    if (stringValue(msg.role) === "user") {
      for (const rawBlock of anySlice(msg.content)) {
        const block = (rawBlock ?? {}) as Json;
        if (block.type === "tool_result") {
          const id = stringValue(block.tool_use_id);
          if (id) ids.add(id);
        }
      }
    }
  }
  return ids;
}

function toolUseIdSet(messages: unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const raw of messages) {
    const msg = (raw ?? {}) as Json;
    if (stringValue(msg.role) !== "assistant") continue;
    for (const rawCall of anySlice(msg.tool_calls)) {
      const id = stringValue(((rawCall ?? {}) as Json).id);
      if (id) ids.add(id);
    }
  }
  return ids;
}

function toolCallFunctionNameMap(messages: unknown[]): Record<string, string> {
  const names: Record<string, string> = {};
  for (const raw of messages) {
    const msg = (raw ?? {}) as Json;
    if (stringValue(msg.role) !== "assistant") continue;
    for (const rawCall of anySlice(msg.tool_calls)) {
      const call = (rawCall ?? {}) as Json;
      const id = stringValue(call.id);
      if (!id) continue;
      const fn = (call.function ?? {}) as Json;
      const name = stringValue(fn.name);
      if (name) names[id] = name;
    }
  }
  return names;
}

function validToolResultIdSet(messages: unknown[]): Set<string> {
  const valid = new Set<string>();
  let lastAssistantToolCallIds = new Set<string>();
  for (const raw of messages) {
    const msg = (raw ?? {}) as Json;
    switch (stringValue(msg.role)) {
      case "assistant": {
        lastAssistantToolCallIds = new Set<string>();
        for (const rawCall of anySlice(msg.tool_calls)) {
          const id = stringValue(((rawCall ?? {}) as Json).id);
          if (id) lastAssistantToolCallIds.add(id);
        }
        break;
      }
      case "tool": {
        const id = stringValue(msg.tool_call_id);
        if (id && lastAssistantToolCallIds.has(id)) valid.add(id);
        break;
      }
      case "user": {
        let hasToolResults = false;
        for (const rawBlock of anySlice(msg.content)) {
          const block = (rawBlock ?? {}) as Json;
          if (block.type !== "tool_result") continue;
          hasToolResults = true;
          const id = stringValue(block.tool_use_id);
          if (id && lastAssistantToolCallIds.has(id)) valid.add(id);
        }
        if (!hasToolResults) lastAssistantToolCallIds = new Set<string>();
        break;
      }
      case "system":
      case "developer":
        lastAssistantToolCallIds = new Set<string>();
        break;
      default:
        break;
    }
  }
  return valid;
}

function openAiToolCallsToGeminiParts(msg: Json, completed: Set<string>): unknown[] {
  const parts: unknown[] = [];
  for (const rawCall of anySlice(msg.tool_calls)) {
    const call = (rawCall ?? {}) as Json;
    const id = stringValue(call.id);
    if (id && !completed.has(id)) continue;
    const fn = (call.function ?? {}) as Json;
    const name = stringValue(fn.name);
    if (!name) continue;
    let args: unknown = {};
    const rawArgs = stringValue(fn.arguments);
    if (rawArgs) {
      try {
        args = JSON.parse(rawArgs);
      } catch {
        args = {};
      }
    }
    parts.push({ functionCall: { name, args, id } });
  }
  return parts;
}

function sanitizeGeminiContents(contents: unknown[]): unknown[] {
  const callIdx = new Map<string, number>();
  const responseIdx = new Map<string, number>();
  contents.forEach((rawContent, idx) => {
    const content = rawContent as Json;
    for (const rawPart of anySlice(content.parts)) {
      const part = rawPart as Json;
      if (part.functionCall !== undefined) {
        const id = stringValue((part.functionCall as Json).id);
        if (id) callIdx.set(id, idx);
      }
      if (part.functionResponse !== undefined) {
        const id = stringValue((part.functionResponse as Json).id);
        if (id) responseIdx.set(id, idx);
      }
    }
  });
  const validCalls = new Set<string>();
  const validResponses = new Set<string>();
  for (const [id, callAt] of callIdx) {
    const responseAt = responseIdx.get(id);
    if (responseAt !== undefined && responseAt > callAt) {
      validCalls.add(id);
      validResponses.add(id);
    }
  }
  const out: unknown[] = [];
  for (const rawContent of contents) {
    const content = rawContent as Json;
    const parts: unknown[] = [];
    for (const rawPart of anySlice(content.parts)) {
      const part = rawPart as Json;
      if (part.functionCall !== undefined && !validCalls.has(stringValue((part.functionCall as Json).id))) continue;
      if (part.functionResponse !== undefined && !validResponses.has(stringValue((part.functionResponse as Json).id))) continue;
      parts.push(rawPart);
    }
    if (parts.length > 0) {
      const copyContent = cloneAnyMap(content);
      copyContent.parts = parts;
      out.push(copyContent);
    }
  }
  return out;
}

function hasFunctionResponsePart(parts: unknown[]): boolean {
  return parts.some((rawPart) => (rawPart as Json).functionResponse !== undefined);
}

function groupConsecutiveToolResponses(contents: unknown[]): unknown[] {
  const out: Json[] = [];
  for (const rawContent of contents) {
    const content = rawContent as Json;
    const parts = anySlice(content.parts);
    if (content.role === "user" && hasFunctionResponsePart(parts) && out.length > 0) {
      const last = out[out.length - 1];
      const lastParts = anySlice(last.parts);
      if (last.role === "user" && hasFunctionResponsePart(lastParts)) {
        last.parts = [...lastParts, ...parts];
        continue;
      }
    }
    const copyContent = cloneAnyMap(content);
    copyContent.parts = [...parts];
    out.push(copyContent);
  }
  return out;
}

function appendContentParts(target: unknown[], content: Json, parts: unknown[]): void {
  if (parts.length === 0) return;
  const copyContent = cloneAnyMap(content);
  copyContent.parts = parts;
  target.push(copyContent);
}

function separateTextAndToolParts(contents: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const rawContent of contents) {
    const content = rawContent as Json;
    const parts = anySlice(content.parts);
    if (parts.length === 0) {
      out.push(rawContent);
      continue;
    }
    const [textParts, thoughtParts, callParts, responseParts, otherParts] = splitGeminiParts(parts);
    if (content.role === "model") {
      if (callParts.length > 0 && textParts.length + thoughtParts.length > 0) {
        appendContentParts(out, content, [...thoughtParts, ...textParts, ...otherParts]);
        appendContentParts(out, content, callParts);
      } else {
        out.push(rawContent);
      }
    } else if (content.role === "user") {
      if (responseParts.length > 0) appendContentParts(out, content, [...responseParts, ...otherParts]);
      else out.push(rawContent);
    } else {
      out.push(rawContent);
    }
  }
  return out;
}

function splitGeminiParts(parts: unknown[]): [unknown[], unknown[], unknown[], unknown[], unknown[]] {
  const textParts: unknown[] = [];
  const thoughtParts: unknown[] = [];
  const callParts: unknown[] = [];
  const responseParts: unknown[] = [];
  const otherParts: unknown[] = [];
  for (const rawPart of parts) {
    const part = rawPart as Json;
    if (part.functionCall !== undefined) callParts.push(rawPart);
    else if (part.functionResponse !== undefined) responseParts.push(rawPart);
    else if (part.thought === true) thoughtParts.push(rawPart);
    else if (part.text !== undefined) textParts.push(rawPart);
    else otherParts.push(rawPart);
  }
  return [textParts, thoughtParts, callParts, responseParts, otherParts];
}

function reasoningEffort(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "";
  return stringValue((value as Json).effort);
}

function requestThinkingConfig(body: Json): Json {
  const config: Json = {};
  const budget = numberFromAny(body.thinking_budget);
  const effort = defaultStringValue(reasoningEffort(body.reasoning), stringValue(body.reasoning_effort));
  if (budget > 0) config.thinkingBudget = budget;
  else if (effort && effort !== "none") {
    const derived = defaultThinkingBudget(effort);
    if (derived > 0) config.thinkingBudget = derived;
  }
  if (Object.keys(config).length > 0 && body.include_thoughts !== undefined) {
    config.include_thoughts = body.include_thoughts;
  }
  return config;
}

function openAiContentToGeminiParts(content: unknown): unknown[] {
  if (content === undefined || content === null) return [];
  if (typeof content === "string") return content ? [{ text: content }] : [];
  const parts: unknown[] = [];
  for (const raw of anySlice(content)) {
    const item = (raw ?? {}) as Json;
    const text = stringValue(item.text);
    if (text) {
      parts.push({ text });
      continue;
    }
    if (item.type === "image_url") {
      const imageUrl = (item.image_url ?? {}) as Json;
      const url = stringValue(imageUrl.url);
      const part = dataUriToGeminiPart(url);
      if (part) parts.push(part);
      else if (url) parts.push({ fileData: { fileUri: url, mimeType: inferMimeTypeFromUrl(url) } });
    }
  }
  return parts;
}

