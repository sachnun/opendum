import { Duration, Effect, Result } from "effect";
import type { OpendumRedis } from "@opendum/core/redis";

import { Value, Payload, Ids, Responses } from "@opendum/providers/core/helpers";
import {
  anySlice,
  defaultAny,
  type Json,
} from "@opendum/providers/upstreams/antigravity/common";
import {
  GeminiCompletion,
  GeminiResponse,
  GeminiSchema,
  GeminiStream,
} from "@opendum/providers/upstreams/antigravity/transform";
import { ChatImageInliner } from "@opendum/providers/core/images";
import { RequestFailure } from "@opendum/providers/core/http";
import { OAuth } from "@opendum/providers/core/oauth";
import { OAuthProvider } from "@opendum/providers/core/provider";
import { CodeAssist, type AccountInfo, type AntigravityOptions } from "@opendum/providers/upstreams/antigravity/options";
import { GeminiModel, GeminiTier } from "@opendum/providers/upstreams/antigravity/model";
import {
  GeminiArtifacts,
  GeminiPayload,
  GeminiTierDetector,
  GeminiToolBlocks,
} from "@opendum/providers/upstreams/antigravity/payload";
import {
  GeminiRequest,
} from "@opendum/providers/upstreams/antigravity/request";
import type {
  ProviderAccount,
  ProviderFailure,
  ProviderRequest,
  RefreshedCredentials,
  ProviderCredentialFailure,
} from "@opendum/providers/types";

import { ANTIGRAVITY_TOKEN_ENDPOINT } from "@opendum/providers/auth/antigravity/constants";

const OAUTH_TOKEN_ENDPOINT = ANTIGRAVITY_TOKEN_ENDPOINT;
const REFRESH_BUFFER_MS = 60 * 60 * 1000;
const MIN_THINKING_BUDGET = 1024;
const MAX_OUTPUT_TOKENS = 64000;
const SIGNATURE_PREFIX = "opendum:thought-signature";
const SIGNATURE_TTL_SECONDS = 24 * 60 * 60;
const CLAUDE_BETA_HEADER = "interleaved-thinking-2025-05-14";
const ANTIGRAVITY_SYSTEM_INSTRUCTION =
  "You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.**Absolute paths only****Proactiveness**";

function normalizeLevel(model: string, level: string): string {
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

export class AntigravityProvider extends OAuthProvider {
  readonly name = "antigravity";
  protected readonly refreshBufferMs = REFRESH_BUFFER_MS;
  private readonly redis: OpendumRedis | null;
  private readonly oauth: OAuth;
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
  private readonly userAgent = `antigravity/2.26.0 ${process.platform}/${process.arch}`;
  private readonly apiClient = "google-cloud-sdk vscode_cloudshelleditor/0.1";
  private readonly clientMetadata =
    '{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}';

  constructor(options: AntigravityOptions) {
    super(options);
    this.oauth = new OAuth({
      provider: "antigravity",
      tokenUrl: OAUTH_TOKEN_ENDPOINT,
      transport: options.transport,
      request: (refreshToken) => ({
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          refresh_token: refreshToken.trim(),
          grant_type: "refresh_token",
        }).toString(),
      }),
      parse: async (payload, refreshToken) => {
        const token = payload as { access_token?: string; refresh_token?: string; expires_in?: number };
        if (!token.access_token) return Result.fail("antigravity token refresh returned empty access token");
        const nextRefresh = token.refresh_token || refreshToken;
        const expiresIn = token.expires_in && token.expires_in > 0 ? token.expires_in : 3600;
        const info = await this.fetchAccountInfo(token.access_token);
        return Result.succeed({
          accessToken: token.access_token,
          refreshToken: nextRefresh,
          expiresAt: new Date(Date.now() + expiresIn * 1000),
          projectId: info.projectId,
          tier: info.tier,
          paidTier: info.paidTier,
          email: info.email,
        });
      },
    });
    this.redis = options.redis ?? null;
    this.persistAccountInfo = options.persistAccountInfo;
  }

  protected exchange(
    refreshToken: string,
    account: ProviderAccount
  ): Effect.Effect<RefreshedCredentials, ProviderCredentialFailure> {
    return this.oauth.exchange(refreshToken, account);
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
      const resp = await this.transport
        .direct(`${endpoint}/v1internal:loadCodeAssist`, {
          method: "POST",
          headers,
          body: JSON.stringify({ metadata: CodeAssist.metadata() }),
        })
        .catch(() => null);
      if (!resp) {
        hadError = true;
        continue;
      }
      let data: Json = {};
      if (resp.status >= 200 && resp.status < 300) {
        data = ((await resp.json().catch(() => null)) as Json | null) ?? {};
      } else {
        hadError = true;
      }
      if (Object.keys(data).length === 0) continue;
      const project = GeminiTierDetector.projectId(data);
      if (project) info.projectId = project;
      if (data.currentTier !== undefined) currentTierPresent = true;
      const currentTierId = GeminiTierDetector.tier(data);
      if (currentTierId) info.tier = currentTierId;
      const tiers = GeminiTierDetector.allowed(data);
      if (tiers.length > 0) allowedTiers = tiers;
      if (!currentTierId) {
        const tier = GeminiTierDetector.detect(data);
        if (tier) info.tier = tier;
      }
      const paidTier = GeminiTierDetector.paidTier(data);
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
    const onboardTier = GeminiTierDetector.selectOnboard(tier, allowedTiers);
    if (!onboardTier) return { projectId: "", tier: "", paidTier: "", email: "" };
    const payload = JSON.stringify({ tierId: onboardTier, metadata: CodeAssist.metadata() });
    const poll = Effect.gen({ self: this }, function* () {
      for (const endpoint of this.onboardEndpoints) {
        let data = yield* Effect.promise(() => this.postOnboardUser(accessToken, endpoint, payload));
        if (!data) continue;
        for (let i = 0; i < 30 && data.done === false; i += 1) {
          yield* Effect.sleep(Duration.millis(2000));
          const polled = yield* Effect.promise(() => this.postOnboardUser(accessToken, endpoint, payload));
          if (polled) data = polled;
        }
        if (data.done === false) continue;
        const response = data.response;
        if (response !== null && typeof response === "object" && !Array.isArray(response)) data = response as Json;
        const project = GeminiTierDetector.projectId(data);
        if (project) {
          return { projectId: project, tier: GeminiTier.normalize(onboardTier), paidTier: "", email: "" };
        }
      }
      return { projectId: "", tier: "", paidTier: "", email: "" };
    });
    return Effect.runPromise(poll);
  }

  private async postOnboardUser(accessToken: string, endpoint: string, payload: string): Promise<Json | null> {
    const headers: Record<string, string> = {};
    this.setGoogleHeaders(headers, accessToken, false);
    const resp = await this.transport
      .direct(`${endpoint}/v1internal:onboardUser`, { method: "POST", headers, body: payload })
      .catch(() => null);
    if (!resp) return null;
    if (resp.status < 200 || resp.status >= 300) return null;
    return (await resp.json().catch(() => null)) as Json | null;
  }

  private async fetchGoogleEmail(accessToken: string): Promise<string> {
    const headers: Record<string, string> = {};
    this.setGoogleHeaders(headers, accessToken, false);
    const resp = await this.transport
      .direct("https://www.googleapis.com/oauth2/v2/userinfo", { headers })
      .catch(() => null);
    if (!resp) return "";
    if (resp.status < 200 || resp.status >= 300) return "";
    const data = ((await resp.json().catch(() => null)) as Json | null) ?? {};
    return Value.string(data.email);
  }

  makeRequest(request: ProviderRequest): Effect.Effect<Response, ProviderFailure> {
    return RequestFailure.normalize(
      "antigravity",
      Effect.gen({ self: this }, function* () {
        const body = request.body;
        let projectId = request.account.projectId?.trim() ?? "";
        if (!projectId) projectId = this.defaultProject;
        if (!projectId) {
          const info = yield* Effect.tryPromise({
            try: () => this.fetchAccountInfo(request.credentials),
            catch: (cause) => RequestFailure.transport("antigravity", cause),
          });
          projectId = info.projectId || this.defaultProject;
          if (projectId && request.account.id) {
            const tier = info.paidTier || info.tier;
            this.persistAccountInfo?.(request.account.id, { projectId, tier, email: info.email });
          }
        }
        if (!projectId) {
          return yield* Effect.fail(
            RequestFailure.transport("antigravity", new Error("antigravity account missing projectId"))
          );
        }

        let modelName = this.resolveModel(Value.string(body.model));
        modelName = this.gemini3Variant(modelName, body);
        let normalizedBody = this.normalizeBody(body, modelName);
        const messages = normalizedBody.messages;
        if (Array.isArray(messages) && modelName.includes("claude")) {
          normalizedBody = Payload.clone(normalizedBody);
          normalizedBody.messages = yield* new ChatImageInliner(this.transport.direct).run(messages);
        }

        const clientSession = Value.string(normalizedBody._sessionId);
        let sessionId = clientSession ? GeminiModel.numericSession(clientSession) : GeminiModel.numericSession(GeminiModel.stableSession(normalizedBody));
        if (!sessionId) sessionId = GeminiModel.numericSession(Ids.uuid());

        const geminiPayload = GeminiRequest.build(normalizedBody);
        yield* Effect.tryPromise({
          try: () => this.transformPayload(geminiPayload, modelName, sessionId),
          catch: (cause) => RequestFailure.transport("antigravity", cause),
        });
        const toolSchemas = GeminiSchema.toolMap(geminiPayload.tools);
        if (!this.configBool(modelName, "strict_tool_schema")) GeminiSchema.sanitizeKeys(toolSchemas);

        const requestPayload = GeminiResponse.wrapCodeAssist(projectId, modelName, geminiPayload);
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
          if (this.needsAnthropicBeta(modelName)) headers["anthropic-beta"] = CLAUDE_BETA_HEADER;
          const url = `${endpoint}/v1internal:${action}`;
          const attempt = yield* Effect.result(
            Effect.tryPromise({
              try: () => this.transport.direct(url, { method: "POST", headers, body: encoded }),
              catch: (cause) => RequestFailure.transport("antigravity", cause, url),
            })
          );
          if (Result.isFailure(attempt)) {
            lastErr = attempt.failure;
            continue;
          }
          const resp: Response = attempt.success;
          if (resp.status === 429) {
            request.onResponseStart?.();
            return resp;
          }
          if ([401, 403, 404].includes(resp.status) || resp.status >= 500) {
            lastResp = resp;
            continue;
          }
          if (resp.status < 200 || resp.status >= 300) {
            request.onResponseStart?.();
            return resp;
          }
          request.onResponseStart?.();
          lastResp = resp;
          lastErr = null;
          break;
        }
        const resp = lastResp;
        if (lastErr) return yield* Effect.fail(lastErr);
        if (!resp || resp.status < 200 || resp.status >= 300) return resp as Response;

        let streamBody: ReadableStream<Uint8Array> | null = resp.body;
        if (request.stream || actualStream) {
          const { retired, notice, body: peeked } = yield* Effect.tryPromise({
            try: () => GeminiResponse.peekNotice(resp as Response),
            catch: (cause) => RequestFailure.transport("antigravity", cause),
          });
          if (retired) return GeminiResponse.retired(notice);
          streamBody = peeked ?? resp.body;
        }
        if (!streamBody) {
          return yield* Effect.fail(
            RequestFailure.transport("antigravity", new Error("antigravity response stream is empty"))
          );
        }

        if (request.stream) {
          return new Response(GeminiStream.sse(this, streamBody, modelName, sessionId, toolSchemas), {
            status: 200,
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            },
          });
        }
        if (actualStream) {
          const completion = yield* Effect.tryPromise({
            try: () => GeminiStream.completion(this, streamBody as ReadableStream<Uint8Array>, modelName, sessionId, toolSchemas),
            catch: (cause) => RequestFailure.transport("antigravity", cause),
          });
          return Responses.json(200, completion);
        }
        const data = (yield* Effect.promise(() => resp.json())) as unknown;
        const response = GeminiResponse.unwrap(data);
        this.cacheSignatures(response, modelName, sessionId);
        return Responses.json(200, GeminiCompletion.build(response, modelName, toolSchemas));
      })
    );
  }

  private configValue(model: string, key: string): unknown {
    const cfg = this.registry.config(model, this.name);
    if (cfg) {
      if (key in cfg) return cfg[key];
      const custom = cfg.custom;
      if (custom && typeof custom === "object" && key in custom) return custom[key];
    }
    const derived = GeminiModel.configValue(this.registry, model, key);
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
      const num = Value.number(entryValue);
      if (num !== 0) out[entryKey] = num;
    }
    return out;
  }

  private resolveModel(model: string): string {
    let value = GeminiModel.segment(model);
    if (value.endsWith(":thinking")) value = value.slice(0, -":thinking".length);
    return this.registry.upstream(value, this.name);
  }

  private gemini3Variant(model: string, body: Json): string {
    if (!GeminiModel.isGemini3(model)) return model;
    const lower = model.toLowerCase();
    if (lower.endsWith("-tiered") || lower.includes("lite") || lower.includes("image")) return model;
    const base = GeminiModel.trimThinkingLevel(model);
    let level = GeminiModel.levelFromName(model);
    const bodyLevel = this.gemini3Level(model, body);
    if (bodyLevel) level = bodyLevel;
    if (!level) level = lower.includes("pro") ? "high" : "medium";
    return `${base}-${level}`;
  }

  private gemini3Level(model: string, body: Json): string {
    const thinking = body.thinking;
    if (thinking !== null && typeof thinking === "object" && !Array.isArray(thinking)) {
      const t = thinking as Json;
      const level = normalizeLevel(model, Value.string(t.thinkingLevel));
      if (level) return level;
      const budget = Value.number(t.budget_tokens);
      if (budget > 0) return this.levelFromBudget(model, budget);
    }
    const bodyBudget = Value.number(body.thinking_budget);
    if (bodyBudget > 0) return this.levelFromBudget(model, bodyBudget);
    const effort = Value.string(body.reasoning_effort);
    if (effort) {
      const level = this.levelFromEffort(model, effort);
      if (level) return level;
    }
    const reasoning = body.reasoning;
    if (reasoning !== null && typeof reasoning === "object" && !Array.isArray(reasoning)) {
      const rEffort = Value.string((reasoning as Json).effort);
      if (rEffort) {
        const level = this.levelFromEffort(model, rEffort);
        if (level) return level;
      }
    }
    return "";
  }

  private normalizeBody(body: Json, model: string): Json {
    const out = Payload.clone(body);
    delete out.logit_bias;
    if (this.configBool(model, "top_p_min_095")) {
      const topP = GeminiModel.float(out.top_p);
      if (topP !== null && topP < 0.95) delete out.top_p;
    }
    return out;
  }

  private needsAnthropicBeta(model: string): boolean {
    if (this.configBool(model, "anthropic_beta")) return true;
    return model.includes("claude") && model.includes("thinking");
  }

  private thinkingLevel(model: string, effort: string): string {
    const levels = this.configStringMap(model, "thinking_levels");
    if (Object.keys(levels).length === 0) return "";
    return levels[effort] || levels.high || "";
  }

  private levelFromBudget(model: string, budget: number): string {
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
    return normalizeLevel(model, level || effort);
  }

  private levelFromEffort(model: string, effort: string): string {
    const level = this.thinkingLevel(model, effort);
    return normalizeLevel(model, level || effort);
  }

  private fitLevel(generation: Json, model: string, level: string): string {
    const maxTokens = Value.number(defaultAny(generation.maxOutputTokens, generation.max_output_tokens));
    if (maxTokens <= 0) return level;
    const budgets = this.configIntMap(model, "thinking_budgets");
    if (Object.keys(budgets).length === 0) return level;
    for (const candidate of ["minimal", "low", "medium", "high", "xhigh"]) {
      const budget = budgets[candidate] ?? 0;
      if (budget <= 0 || budget > maxTokens / 2) continue;
      const normalized = normalizeLevel(model, candidate);
      return normalized || candidate;
    }
    return "";
  }

  private normalizeThinking(thinking: Json | null, model: string): Json | null {
    const out: Json = {};
    const include = defaultAny(thinking?.includeThoughts, thinking?.include_thoughts);
    if (typeof include === "boolean") out.includeThoughts = include;
    let level = Value.stringOr(thinking?.thinkingLevel, Value.string(thinking?.thinking_level));
    if (!level) {
      const budget = Value.number(defaultAny(thinking?.thinkingBudget, thinking?.thinking_budget));
      if (budget > 0) level = this.levelFromBudget(model, budget);
    } else {
      level = normalizeLevel(model, level);
    }
    if (!level) level = GeminiModel.levelFromName(model);
    if (!level && GeminiModel.segment(model).toLowerCase().endsWith("-tiered")) level = "medium";
    if (level) {
      out.thinkingLevel = level;
      if (out.includeThoughts === undefined) out.includeThoughts = true;
    }
    return Object.keys(out).length === 0 ? null : out;
  }

  private applyThinkingConfig(payload: Json, model: string, effort: string, budget: number): void {
    const config: Json = {};
    if (GeminiModel.isGemini3(model)) {
      let level = "";
      if (budget > 0) level = this.levelFromBudget(model, budget);
      else if (effort && effort !== "none") level = this.levelFromEffort(model, effort);
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
      if (this.configBool(model, "thinking_model") || GeminiModel.isTieredGemini3(model) || GeminiModel.isGemini3(model)) {
        generation = {};
        payload.generationConfig = generation;
      } else {
        return;
      }
    }
    const rawThinking =
      (generation.thinkingConfig as Json | undefined) ?? null;
    if (GeminiModel.isGemini3(model)) {
      const thinking = this.normalizeThinking(rawThinking, model);
      if (thinking) {
        const level = this.fitLevel(generation, model, Value.string(thinking.thinkingLevel));
        if (!level) {
          delete generation.thinkingConfig;
          return;
        }
        thinking.thinkingLevel = level;
        generation.thinkingConfig = thinking;
        const budgets = this.configIntMap(model, "thinking_budgets");
        if ((budgets[level] ?? 0) > 0) {
          const maxTokens = Value.number(defaultAny(generation.maxOutputTokens, generation.max_output_tokens));
          if (maxTokens === 0) {
            generation.maxOutputTokens = MAX_OUTPUT_TOKENS;
            delete generation.max_output_tokens;
          }
        }
      } else {
        delete generation.thinkingConfig;
      }
      return;
    }
    const thinking = GeminiPayload.thinkingMap(rawThinking);
    if (this.configBool(model, "thinking_model")) {
      if (!thinking) {
        delete generation.thinkingConfig;
        if (Value.number(defaultAny(generation.maxOutputTokens, generation.max_output_tokens)) === 0) {
          generation.maxOutputTokens = MAX_OUTPUT_TOKENS;
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
          include_thoughts: GeminiModel.bool(
            defaultAny(thinking.include_thoughts, thinking.includeThoughts),
            true
          ),
        };
        const budget = Value.number(defaultAny(thinking.thinkingBudget, thinking.thinking_budget));
        if (budget > 0) strict.thinking_budget = budget;
        finalThinking = strict;
      }
      generation.thinkingConfig = finalThinking;
      const budget = Value.number(defaultAny(thinking.thinkingBudget, thinking.thinking_budget));
      if (budget > 0) {
        let answer = Value.number(defaultAny(generation.maxOutputTokens, generation.max_output_tokens));
        if (answer <= 0) answer = MAX_OUTPUT_TOKENS;
        let maxTokens = answer + budget;
        const cfg = this.registry.config(model, this.name);
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
    const hash = new Bun.CryptoHasher("sha256")
      .update(`${this.signatureFamily(model)}:${sessionId}:${thoughtText.trim()}`)
      .digest("hex");
    return `${SIGNATURE_PREFIX}:${hash}`;
  }

  async getCachedSignature(model: string, sessionId: string, thoughtText: string): Promise<string> {
    if (!this.redis || !sessionId || !thoughtText.trim()) return "";
    const raw = await this.redis.get(this.signatureCacheKey(model, sessionId, thoughtText)).catch(() => null);
    if (!raw) return "";
    const cached = Value.parseJson(raw) as Json;
    return Value.string(cached?.signature);
  }

  async cacheSignature(model: string, sessionId: string, thoughtText: string, signature: string): Promise<void> {
    if (!this.redis || !sessionId || !thoughtText.trim() || !signature.trim()) return;
    await this.redis
      .set(this.signatureCacheKey(model, sessionId, thoughtText), JSON.stringify({ signature }), {
        EX: SIGNATURE_TTL_SECONDS,
      })
      .catch(() => undefined);
  }

  async cacheSignatures(response: Json, model: string, sessionId: string): Promise<void> {
    for (const candidate of anySlice(response.candidates)) {
      const content = ((candidate as Json).content ?? {}) as Json;
      for (const rawPart of anySlice(content.parts)) {
        const part = (rawPart ?? {}) as Json;
        if (part.thought === true) {
          const text = Value.string(part.text);
          const signature = Value.string(part.thoughtSignature);
          if (text && signature) await this.cacheSignature(model, sessionId, text, signature);
        }
      }
    }
  }

  async transformPayload(payload: Json, model: string, sessionId: string): Promise<void> {
    delete payload.safetySettings;
    if (payload.system_instruction !== undefined) {
      payload.systemInstruction = payload.system_instruction;
      delete payload.system_instruction;
    }
    GeminiPayload.normalizeCached(payload);
    delete payload.model;
    GeminiPayload.ensureToolConfig(payload);
    this.normalizeThinkingConfig(payload, model);
    if (this.configBool(model, "strict_tool_schema")) GeminiPayload.normalizeClaudeTools(payload);
    else GeminiPayload.sanitizeToolNames(payload);
    GeminiPayload.sortDeclarations(payload);
    this.applySystemInstruction(payload, model);
    await this.normalizeContents(payload, model, sessionId);
    GeminiPayload.stripTrailingTurns(payload);
    payload.sessionId = sessionId;
  }

  private applySystemInstruction(payload: Json, model: string): void {
    let needsInjection = this.configBool(model, "system_instruction");
    if (!needsInjection) {
      if (this.registry.config(model, this.name)) return;
      needsInjection = GeminiModel.needsSystemInstruction(model);
    }
    if (!needsInjection) return;
    const parts: unknown[] = [{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION }];
    let existingRecord: Json = {};
    const existing = payload.systemInstruction;
    if (typeof existing === "string" && existing) {
      parts.push({ text: existing });
    } else if (existing !== null && typeof existing === "object" && !Array.isArray(existing)) {
      existingRecord = Payload.clone(existing as Json);
      if (Array.isArray((existing as Json).parts)) parts.push(...((existing as Json).parts as unknown[]));
    }
    existingRecord.role = "user";
    existingRecord.parts = parts;
    payload.systemInstruction = existingRecord;
  }

  private async normalizeContents(payload: Json, model: string, sessionId: string): Promise<void> {
    const contents = anySlice(payload.contents);
    const strict = this.configBool(model, "strict_tool_schema");
    const callIdQueues: Record<string, string[]> = {};
    for (const rawContent of contents) {
      const content = rawContent as Json;
      if (this.configBool(model, "scrub_model_artifacts") && content.role === "model") {
        GeminiArtifacts.scrubContent(content);
      }
      const parts = anySlice(content.parts);
      const filtered: unknown[] = [];
      let currentThoughtSignature = "";
      for (const rawPart of parts) {
        const part = rawPart as Json;
        if (typeof part.text === "string" && part.text === "") continue;
        if (part.thought === true) {
          const thoughtText = Value.string(part.text);
          let signature = Value.string(part.thoughtSignature);
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
          const name = Value.string(fn.name);
          if (fn.id === undefined || fn.id === null) fn.id = Ids.random(name);
          if (strict && name) {
            callIdQueues[name] = callIdQueues[name] ?? [];
            callIdQueues[name].push(Value.string(fn.id));
          }
          if (!strict && this.configBool(model, "inject_thought_signature") && part.thoughtSignature === undefined) {
            part.thoughtSignature = currentThoughtSignature || "skip_thought_signature_validator";
          }
        }
        if (part.functionResponse !== undefined && part.functionResponse !== null) {
          const fn = part.functionResponse as Json;
          if (fn.id === undefined || fn.id === null) {
            const name = Value.string(fn.name);
            if (strict && callIdQueues[name] && callIdQueues[name].length > 0) {
              fn.id = callIdQueues[name].shift();
            } else {
              fn.id = Ids.random(name);
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
      payload.contents = GeminiToolBlocks.sanitize(contents);
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
