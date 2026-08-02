import type Redis from "ioredis";
import { eq } from "drizzle-orm";
import type { ProxyDB } from "../db/index.js";
import { schema } from "../db/index.js";
import type { Registry } from "../registry/index.js";
import { jsonResponse, sseResponse, stringValue, defaultStringValue, defaultAny, numberFromAny, readAllText, randomID, iterateLines } from "./http.js";
import { sha256Hex, randomUUID, randomHyphenID, providerConfigBool, providerConfigString, providerConfigStringMap, providerConfigIntMap, normalizeAntigravityTieredModel } from "./model_helpers.js";
import { contentToText } from "./responses_transform.js";
import type { HttpClient, Provider, ProviderAccountLike, RefreshedCredentials, RequestContext, UpstreamResponse } from "./types.js";
import { markUpstreamResponseStarted } from "./latency.js";

const googleOAuthTokenEndpoint = "https://oauth2.googleapis.com/token";
const antigravitySignatureCachePrefix = "opendum:thought-signature";
const antigravitySignatureCacheTTL = 24 * 3600 * 1000;
const antigravityClaudeBetaHeader = "interleaved-thinking-2025-05-14";
const antigravityAuthUserAgent = "google-api-nodejs-client/10.3.0";
const antigravityAuthAPIClient = "gl-node/22.18.0";
const antigravityAuthClientMetadata = '{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}';
const antigravityUserAgent = "antigravity/1.653.24 ";

export class GoogleCodeAssistProvider implements Provider {
  name: string;
  clientID: string;
  clientSecret: string;
  endpoint: string;
  endpoints: string[];
  loadEndpoints: string[];
  onboardEndpoints: string[];
  refreshBufferMs: number;
  defaultProject: string;
  userAgent: string;
  apiClient: string;
  clientMetadata: string;
  registry: Registry | null;
  db: ProxyDB | null;
  redis: Redis | null;

  constructor(opts: Partial<GoogleCodeAssistProvider> & { name: string; clientID: string; clientSecret: string; endpoint: string }) {
    this.name = opts.name;
    this.clientID = opts.clientID;
    this.clientSecret = opts.clientSecret;
    this.endpoint = opts.endpoint;
    this.endpoints = opts.endpoints ?? [];
    this.loadEndpoints = opts.loadEndpoints ?? [];
    this.onboardEndpoints = opts.onboardEndpoints ?? [];
    this.refreshBufferMs = opts.refreshBufferMs ?? 3 * 3600 * 1000;
    this.defaultProject = opts.defaultProject ?? "";
    this.userAgent = opts.userAgent ?? "";
    this.apiClient = opts.apiClient ?? "";
    this.clientMetadata = opts.clientMetadata ?? "";
    this.registry = opts.registry ?? null;
    this.db = opts.db ?? null;
    this.redis = opts.redis ?? null;
  }

  refreshBuffer(): number {
    return this.refreshBufferMs;
  }

  async refreshCredentials(ctx: RequestContext, client: HttpClient, refreshToken: string, _account: ProviderAccountLike): Promise<RefreshedCredentials> {
    const form = new URLSearchParams();
    form.set("client_id", this.clientID);
    form.set("client_secret", this.clientSecret);
    form.set("refresh_token", refreshToken.trim());
    form.set("grant_type", "refresh_token");
    const resp = await client.fetch(googleOAuthTokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: ctx.signal,
    });
    if (resp.status < 200 || resp.status >= 300) {
      const body = await readAllText(resp.body);
      throw new Error(`${this.name} token refresh failed: ${resp.status} ${body}`);
    }
    const token = (await readAllJSONSafe(resp.body)) as Record<string, unknown>;
    const accessToken = stringValue(token["access_token"]);
    if (accessToken === "") {
      throw new Error(`${this.name} token refresh returned empty access token`);
    }
    let newRefreshToken = stringValue(token["refresh_token"]);
    if (newRefreshToken === "") newRefreshToken = refreshToken;
    let expiresIn = numberFromAny(token["expires_in"]);
    if (expiresIn <= 0) expiresIn = 3600;
    const info = await this.fetchAccountInfo(client, ctx, accessToken);
    return { accessToken, refreshToken: newRefreshToken, expiresAt: new Date(Date.now() + expiresIn * 1000), projectId: info.projectID, tier: info.tier, email: info.email, accountId: "", storeAccessToken: "" };
  }

  async makeRequest(client: HttpClient, ctx: RequestContext, accessToken: string, account: ProviderAccountLike, body: Record<string, unknown>, stream: boolean): Promise<UpstreamResponse> {
    let projectID = "";
    if (account.projectId !== null) projectID = account.projectId.trim();
    if (this.name === "antigravity" && projectID === "") projectID = this.defaultProject;
    if (projectID === "") {
      const info = await this.fetchAccountInfo(client, ctx, accessToken);
      projectID = info.projectID;
      if (projectID === "") projectID = this.defaultProject;
      if (projectID !== "" && this.db) {
        void this.db.update(schema.providerAccount).set({ projectId: projectID, tier: info.tier, email: info.email }).where(eq(schema.providerAccount.id, account.id));
      }
    }
    if (projectID === "") {
      throw new Error(`${this.name} account missing projectId`);
    }

    let modelName = this.resolveModel(stringValue(body["model"]));
    if (this.name === "antigravity") {
      modelName = this.resolveAntigravityGemini3ModelVariant(modelName, body);
    }
    let normalizedBody = this.normalizeBodyForModel(body, modelName);
    const messages = normalizedBody["messages"];
    if (Array.isArray(messages) && (this.name !== "antigravity" || modelName.includes("claude"))) {
      normalizedBody["messages"] = await convertImageURLsToBase64Local(client, ctx, messages);
    }
    const sessionID = randomUUID();
    let geminiPayload = openAIToGemini(normalizedBody);
    if (this.name === "antigravity") {
      await this.transformAntigravityPayload(geminiPayload, modelName, sessionID);
    } else {
      this.applyThinkingConfig(geminiPayload, modelName, stringValue(normalizedBody["reasoning_effort"]), numberFromAny(normalizedBody["thinking_budget"]));
    }
    const toolSchemas = buildToolSchemaMap(geminiPayload["tools"]);
    if (this.name === "antigravity" && !providerConfigBool(this.registry, modelName, this.name, "strict_tool_schema")) {
      sanitizeToolSchemaKeys(toolSchemas);
    }
    const requestPayload = this.wrapCodeAssistPayload(projectID, modelName, geminiPayload);
    let actualStream = stream;
    if (this.name === "antigravity" && !modelName.includes("gemini") && !stream) {
      actualStream = true;
    } else if (providerConfigBool(this.registry, modelName, this.name, "force_stream_non_stream") && !stream) {
      actualStream = true;
    }
    let action = "generateContent";
    if (actualStream) action = "streamGenerateContent?alt=sse";
    const encoded = JSON.stringify(requestPayload);

    let lastResp: UpstreamResponse | null = null;
    let lastErr: Error | null = null;
    for (const endpoint of this.endpointsOrDefault()) {
      const headers: Record<string, string> = this.googleGenerationHeaders(accessToken, actualStream);
      if (this.name === "antigravity" && this.shouldSetAnthropicBeta(modelName)) {
        headers["anthropic-beta"] = antigravityClaudeBetaHeader;
      }
      let resp: UpstreamResponse;
      try {
        resp = await client.fetch(endpoint + "/v1internal:" + action, { method: "POST", headers, body: encoded, signal: ctx.signal });
      } catch (error) {
        lastErr = error as Error;
        continue;
      }
      if (resp.status === 429) {
        if (typeof (ctx as { recordResponseStart?: unknown }).recordResponseStart === "function") markUpstreamResponseStarted(ctx as never);
        return resp;
      }
      if (resp.status >= 500 || resp.status === 401 || resp.status === 403 || resp.status === 404) {
        const data = await readAllText(resp.body);
        lastResp = { ...resp, body: streamFromStringSafe(data) };
        continue;
      }
      if (resp.status < 200 || resp.status >= 300) {
        if (typeof (ctx as { recordResponseStart?: unknown }).recordResponseStart === "function") markUpstreamResponseStarted(ctx as never);
        return resp;
      }
      if (typeof (ctx as { recordResponseStart?: unknown }).recordResponseStart === "function") markUpstreamResponseStarted(ctx as never);
      lastResp = resp;
      lastErr = null;
      break;
    }
    if (lastErr || !lastResp || lastResp.status < 200 || lastResp.status >= 300) {
      return lastResp ?? { status: 502, headers: {}, body: null };
    }
    if (stream) {
      return sseResponse(this.geminiSSEToOpenAISSE(lastResp.body, modelName, sessionID, toolSchemas));
    }
    if (actualStream) {
      const completion = await this.geminiStreamToOpenAICompletion(lastResp.body, modelName, sessionID, toolSchemas);
      return jsonResponse(200, completion);
    }
    const data = await readAllJSONSafe(lastResp.body);
    const response = unwrapGeminiResponse(data);
    this.cacheSignaturesFromResponse(response, modelName, sessionID);
    return jsonResponse(200, geminiToOpenAICompletion(response, modelName, toolSchemas));
  }

  wrapCodeAssistPayload(projectID: string, model: string, geminiPayload: Record<string, unknown>): Record<string, unknown> {
    if (this.name !== "antigravity") {
      return { model, project: projectID, user_prompt_id: randomID("prompt"), request: geminiPayload };
    }
    return { project: projectID, model, userAgent: "antigravity", requestType: "agent", requestId: randomHyphenID("agent"), request: geminiPayload };
  }

  shouldSetAnthropicBeta(model: string): boolean {
    if (providerConfigBool(this.registry, model, this.name, "anthropic_beta")) return true;
    return model.includes("claude") && model.includes("thinking");
  }

  async transformAntigravityPayload(payload: Record<string, unknown>, model: string, sessionID: string): Promise<void> {
    delete payload["safetySettings"];
    if (payload["system_instruction"] !== undefined) {
      payload["systemInstruction"] = payload["system_instruction"];
      delete payload["system_instruction"];
    }
    this.normalizeCachedContent(payload);
    delete payload["model"];
    ensureToolConfig(payload);
    this.normalizeThinkingConfig(payload, model);
    if (providerConfigBool(this.registry, model, this.name, "strict_tool_schema")) {
      normalizeClaudeTools(payload);
    } else {
      sanitizeGeminiToolNames(payload);
      augmentToolDescriptions(payload);
      injectGeminiToolInstruction(payload);
    }
    this.applyAntigravitySystemInstruction(payload, model);
    await this.normalizeAntigravityContents(payload, model, sessionID);
    payload["sessionId"] = sessionID;
  }

  normalizeCachedContent(payload: Record<string, unknown>): void {
    const extra = payload["extra_body"];
    if (extra && typeof extra === "object") {
      const e = extra as Record<string, unknown>;
      const value = defaultStringValue(e["cached_content"], stringValue(e["cachedContent"]));
      if (value !== "") payload["cachedContent"] = value;
      delete e["cached_content"];
      delete e["cachedContent"];
      if (Object.keys(e).length === 0) delete payload["extra_body"];
    }
    const direct = defaultStringValue(payload["cached_content"], stringValue(payload["cachedContent"]));
    if (direct !== "") payload["cachedContent"] = direct;
    delete payload["cached_content"];
    delete payload["cachedContent"];
  }

  normalizeThinkingConfig(payload: Record<string, unknown>, model: string): void {
    let generation = (payload["generationConfig"] ?? {}) as Record<string, unknown>;
    if (Object.keys(generation).length === 0 && !providerConfigBool(this.registry, model, this.name, "thinking_model")) return;
    const rawThinking = (generation["thinkingConfig"] ?? null) as Record<string, unknown> | null;
    if (isGemini3ModelName(model)) {
      const thinking = this.normalizeGemini3ThinkingConfig(rawThinking, model);
      if (thinking) {
        generation["thinkingConfig"] = thinking;
        this.ensureGemini3MaxOutputTokens(generation, model, stringValue(thinking["thinkingLevel"]));
      } else {
        delete generation["thinkingConfig"];
      }
      payload["generationConfig"] = generation;
      return;
    }
    const thinking = normalizedThinkingMap(rawThinking);
    if (providerConfigBool(this.registry, model, this.name, "thinking_model")) {
      let finalThinking = thinking ?? { thinkingBudget: 16384, include_thoughts: true };
      if (finalThinking["include_thoughts"] === undefined && finalThinking["includeThoughts"] === undefined) {
        finalThinking["include_thoughts"] = true;
      }
      if (finalThinking["thinkingBudget"] === undefined && finalThinking["thinking_budget"] === undefined) {
        finalThinking["thinkingBudget"] = 16384;
      }
      if (providerConfigBool(this.registry, model, this.name, "strict_tool_schema")) {
        const include = defaultBool(finalThinking["include_thoughts"], defaultBool(finalThinking["includeThoughts"], true));
        const strict: Record<string, unknown> = { include_thoughts: include };
        const budget = numberFromAny(defaultAny(finalThinking["thinkingBudget"], finalThinking["thinking_budget"]));
        if (budget > 0) strict["thinking_budget"] = budget;
        finalThinking = strict;
      }
      generation["thinkingConfig"] = finalThinking;
      const budget = numberFromAny(defaultAny(finalThinking["thinkingBudget"], finalThinking["thinking_budget"]));
      if (budget > 0) {
        const maxTokens = numberFromAny(defaultAny(generation["maxOutputTokens"], generation["max_output_tokens"]));
        if (maxTokens === 0 || maxTokens <= budget) {
          generation["maxOutputTokens"] = 64000;
          delete generation["max_output_tokens"];
        }
      }
      payload["generationConfig"] = generation;
      return;
    }
    if (thinking) {
      generation["thinkingConfig"] = thinking;
    } else {
      delete generation["thinkingConfig"];
    }
    payload["generationConfig"] = generation;
  }

  normalizeGemini3ThinkingConfig(thinking: Record<string, unknown> | null, model: string): Record<string, unknown> | null {
    const out: Record<string, unknown> = {};
    const include = defaultAny(thinking?.["includeThoughts"], thinking?.["include_thoughts"]);
    if (typeof include === "boolean") out["includeThoughts"] = include;
    let level = defaultStringValue(thinking?.["thinkingLevel"], stringValue(thinking?.["thinking_level"]));
    if (level === "") {
      const budget = numberFromAny(defaultAny(thinking?.["thinkingBudget"], thinking?.["thinking_budget"]));
      if (budget > 0) level = this.thinkingLevelFromBudget(model, budget);
    } else {
      level = this.normalizeGemini3ThinkingLevel(model, level);
    }
    if (level === "") level = geminiThinkingLevelFromModel(model);
    if (level !== "") {
      out["thinkingLevel"] = level;
      if (out["includeThoughts"] === undefined) out["includeThoughts"] = true;
    }
    if (Object.keys(out).length === 0) return null;
    return out;
  }

  ensureGemini3MaxOutputTokens(generation: Record<string, unknown>, model: string, level: string): void {
    const budgets = providerConfigIntMap(this.registry, model, this.name, "thinking_budgets");
    const budget = budgets[level] ?? 0;
    if (budget <= 0) return;
    const maxTokens = numberFromAny(defaultAny(generation["maxOutputTokens"], generation["max_output_tokens"]));
    if (maxTokens === 0 || maxTokens <= budget) {
      generation["maxOutputTokens"] = 64000;
      delete generation["max_output_tokens"];
    }
  }

  thinkingLevelFromBudget(model: string, budget: number): string {
    let effort = "high";
    const budgets = providerConfigIntMap(this.registry, model, this.name, "thinking_budgets");
    const low = budgets["low"] ?? 0;
    const medium = budgets["medium"] ?? 0;
    if (low > 0 && budget <= low) {
      effort = "low";
    } else if (medium > 0 && budget <= medium) {
      effort = "medium";
    } else if (Object.keys(budgets).length === 0) {
      if (budget <= 8192) effort = "low";
      else if (budget <= 16384) effort = "medium";
    }
    const level = this.thinkingLevel(model, effort);
    if (level !== "") return this.normalizeGemini3ThinkingLevel(model, level);
    return this.normalizeGemini3ThinkingLevel(model, effort);
  }

  thinkingLevelFromEffort(model: string, effort: string): string {
    const level = this.thinkingLevel(model, effort);
    if (level !== "") return this.normalizeGemini3ThinkingLevel(model, level);
    return this.normalizeGemini3ThinkingLevel(model, effort);
  }

  normalizeGemini3ThinkingLevel(model: string, level: string): string {
    level = level.trim().toLowerCase();
    switch (level) {
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
        return level;
      default:
        return "";
    }
  }

  thinkingLevel(model: string, effort: string): string {
    const levels = providerConfigStringMap(this.registry, model, this.name, "thinking_levels");
    if (Object.keys(levels).length === 0) return "";
    return levels[effort] ?? levels["high"] ?? "";
  }

  thinkingBudget(model: string, effort: string): number {
    const budgets = providerConfigIntMap(this.registry, model, this.name, "thinking_budgets");
    if (Object.keys(budgets).length === 0) return 0;
    return budgets[effort] ?? budgets["high"] ?? 0;
  }

  applyThinkingConfig(payload: Record<string, unknown>, model: string, effort: string, budget: number): void {
    const config: Record<string, unknown> = {};
    if (isGemini3ModelName(model)) {
      let level = "";
      if (budget > 0) {
        level = this.thinkingLevelFromBudget(model, budget);
      } else if (effort !== "" && effort !== "none") {
        level = this.thinkingLevelFromEffort(model, effort);
      }
      if (level !== "") {
        config["thinkingLevel"] = level;
        config["includeThoughts"] = true;
      }
    } else {
      const format = providerConfigString(this.registry, model, this.name, "thinking_format") || "budget";
      if (budget > 0 && format !== "level") {
        config["thinkingBudget"] = budget;
        config["includeThoughts"] = true;
      } else if (effort !== "" && effort !== "none") {
        if (format === "level") {
          const level = this.thinkingLevel(model, effort);
          if (level !== "") config["thinkingLevel"] = level;
        } else {
          const thinkingBudget = this.thinkingBudget(model, effort);
          if (thinkingBudget > 0) config["thinkingBudget"] = thinkingBudget;
        }
        config["includeThoughts"] = true;
      }
    }
    if (Object.keys(config).length === 0) return;
    let generation = (payload["generationConfig"] ?? {}) as Record<string, unknown>;
    if (Object.keys(generation).length === 0) generation = {};
    generation["thinkingConfig"] = config;
    payload["generationConfig"] = generation;
  }

  resolveModel(model: string): string {
    let m = lastModelSegment(model);
    if (m.endsWith(":thinking")) m = m.slice(0, -":thinking".length);
    if (this.registry) return this.registry.upstreamModelName(m, this.name);
    return m;
  }

  resolveAntigravityGemini3ModelVariant(model: string, body: Record<string, unknown>): string {
    if (!isGemini3ModelName(model)) return model;
    if (model.toLowerCase().includes("flash") && model.toLowerCase().includes("3.5")) {
      const base = trimGeminiThinkingLevelSuffix(model);
      let level = geminiThinkingLevelFromModel(model);
      const bodyLevel = this.requestedGemini3ThinkingLevel(model, body);
      if (bodyLevel !== "") level = bodyLevel;
      if (level === "") level = "medium";
      return base + "-" + level;
    }
    if (!model.toLowerCase().includes("pro")) return model;
    const base = trimGeminiThinkingLevelSuffix(model);
    let level = geminiThinkingLevelFromModel(model);
    const bodyLevel = this.requestedGemini3ThinkingLevel(model, body);
    if (bodyLevel !== "") level = bodyLevel;
    if (level === "") level = "high";
    return base + "-" + level;
  }

  requestedGemini3ThinkingLevel(model: string, body: Record<string, unknown>): string {
    const thinking = body["thinking"];
    if (thinking && typeof thinking === "object") {
      const t = thinking as Record<string, unknown>;
      const level = this.normalizeGemini3ThinkingLevel(model, stringValue(t["thinkingLevel"]));
      if (level !== "") return level;
      const budget = numberFromAny(t["budget_tokens"]);
      if (budget > 0) return this.thinkingLevelFromBudget(model, budget);
    }
    const budget = numberFromAny(body["thinking_budget"]);
    if (budget > 0) return this.thinkingLevelFromBudget(model, budget);
    const effort = stringValue(body["reasoning_effort"]);
    if (effort !== "") {
      const level = this.thinkingLevelFromEffort(model, effort);
      if (level !== "") return level;
    }
    const reasoning = body["reasoning"];
    if (reasoning && typeof reasoning === "object") {
      const effort2 = stringValue((reasoning as Record<string, unknown>)["effort"]);
      if (effort2 !== "") {
        const level = this.thinkingLevelFromEffort(model, effort2);
        if (level !== "") return level;
      }
    }
    return "";
  }

  normalizeBodyForModel(body: Record<string, unknown>, model: string): Record<string, unknown> {
    const out = cloneAnyMap(body);
    delete out["logit_bias"];
    if (providerConfigBool(this.registry, model, this.name, "top_p_min_095")) {
      const topP = numberFromAny(out["top_p"]);
      if (topP !== 0 && topP < 0.95) delete out["top_p"];
    }
    return out;
  }

  endpointsOrDefault(): string[] {
    return this.endpoints.length > 0 ? this.endpoints : [this.endpoint];
  }

  applyAntigravitySystemInstruction(payload: Record<string, unknown>, model: string): void {
    let needsInjection = false;
    if (this.registry) {
      needsInjection = providerConfigBool(this.registry, model, this.name, "system_instruction");
      if (!needsInjection) {
        if (this.registry.providerModelConfig(model, this.name)) {
          return;
        }
        needsInjection = fallbackAntigravitySystemInstructionModel(model);
      }
    } else {
      needsInjection = fallbackAntigravitySystemInstructionModel(model);
    }
    if (!needsInjection) return;

    const parts: unknown[] = [{ text: antigravitySystemInstruction }];
    const existingRecord: Record<string, unknown> = {};
    const text = stringValue(payload["systemInstruction"]);
    if (text !== "") {
      parts.push({ text });
    } else if (payload["systemInstruction"] && typeof payload["systemInstruction"] === "object") {
      const existing = payload["systemInstruction"] as Record<string, unknown>;
      Object.assign(existingRecord, cloneAnyMap(existing));
      if (Array.isArray(existing["parts"])) {
        parts.push(...(existing["parts"] as unknown[]));
      }
    }
    existingRecord["role"] = "user";
    existingRecord["parts"] = parts;
    payload["systemInstruction"] = existingRecord;
  }

  async normalizeAntigravityContents(payload: Record<string, unknown>, model: string, sessionID: string): Promise<void> {
    const contents = (payload["contents"] ?? []) as unknown[];
    const strictToolSchema = providerConfigBool(this.registry, model, this.name, "strict_tool_schema");
    const functionCallIDQueues = new Map<string, string[]>();
    for (const rawContent of contents) {
      const content = (rawContent ?? {}) as Record<string, unknown>;
      if (providerConfigBool(this.registry, model, this.name, "scrub_model_artifacts") && content["role"] === "model") {
        scrubConversationArtifacts(content);
      }
      const parts = (content["parts"] ?? []) as unknown[];
      const filtered: unknown[] = [];
      let currentThoughtSignature = "";
      for (const rawPart of parts) {
        const part = (rawPart ?? {}) as Record<string, unknown>;
        if (typeof part["text"] === "string" && part["text"] === "") continue;
        if (part["thought"] === true) {
          const thoughtText = stringValue(part["text"]);
          let signature = stringValue(part["thoughtSignature"]);
          if (strictToolSchema) {
            if (signature === "" || signature.length < 50) {
              const cached = await this.getCachedSignature(model, sessionID, thoughtText);
              if (cached !== "") {
                signature = cached;
                part["thoughtSignature"] = cached;
              }
            }
            if (signature.length > 50) {
              this.cacheSignature(model, sessionID, thoughtText, signature);
              currentThoughtSignature = signature;
            } else {
              continue;
            }
          } else {
            const cached = await this.getCachedSignature(model, sessionID, thoughtText);
            if (cached !== "") {
              part["thoughtSignature"] = cached;
              currentThoughtSignature = cached;
              filtered.push(rawPart);
            }
            continue;
          }
        }
        if (part["functionCall"] !== undefined) {
          const fn = (part["functionCall"] ?? {}) as Record<string, unknown>;
          const name = stringValue(fn["name"]);
          if (fn["id"] === undefined) fn["id"] = randomID(name);
          if (strictToolSchema && name !== "") {
            const queue = functionCallIDQueues.get(name) ?? [];
            queue.push(stringValue(fn["id"]));
            functionCallIDQueues.set(name, queue);
          }
          if (!strictToolSchema && providerConfigBool(this.registry, model, this.name, "inject_thought_signature") && part["thoughtSignature"] === undefined) {
            part["thoughtSignature"] = currentThoughtSignature !== "" ? currentThoughtSignature : "skip_thought_signature_validator";
          }
        }
        if (part["functionResponse"] !== undefined) {
          const fn = (part["functionResponse"] ?? {}) as Record<string, unknown>;
          if (fn["id"] === undefined) {
            const name = stringValue(fn["name"]);
            if (strictToolSchema && functionCallIDQueues.has(name) && (functionCallIDQueues.get(name)?.length ?? 0) > 0) {
              fn["id"] = functionCallIDQueues.get(name)!.shift();
            } else {
              fn["id"] = randomID(name);
            }
          }
        }
        if (!strictToolSchema && part["thoughtSignature"] !== undefined && part["functionCall"] === undefined) {
          delete part["thoughtSignature"];
        }
        filtered.push(rawPart);
      }
      content["parts"] = filtered;
    }
    if (strictToolSchema || providerConfigBool(this.registry, model, this.name, "sanitize_tool_blocks")) {
      payload["contents"] = sanitizeToolBlocks(contents);
    }
  }

  getCachedSignature(model: string, sessionID: string, thoughtText: string): Promise<string> {
    if (!this.redis || sessionID === "" || thoughtText.trim() === "") return Promise.resolve("");
    return this.redis
      .get(this.signatureCacheKey(model, sessionID, thoughtText))
      .then((data) => {
        if (!data) return "";
        try {
          const cached = JSON.parse(data) as { signature?: unknown };
          return stringValue(cached["signature"]);
        } catch {
          return "";
        }
      })
      .catch(() => "");
  }

  cacheSignature(model: string, sessionID: string, thoughtText: string, signature: string): void {
    if (!this.redis || sessionID === "" || thoughtText.trim() === "" || signature.trim() === "") return;
    void this.redis.set(this.signatureCacheKey(model, sessionID, thoughtText), JSON.stringify({ signature }), "PX", antigravitySignatureCacheTTL);
  }

  signatureFamily(model: string): string {
    const family = providerConfigString(this.registry, model, this.name, "signature_family");
    if (family !== "") return family;
    return providerConfigString(this.registry, model, this.name, "transform");
  }

  signatureCacheKey(model: string, sessionID: string, thoughtText: string): string {
    const normalized = thoughtText.trim();
    return antigravitySignatureCachePrefix + ":" + sha256Hex(this.signatureFamily(model) + ":" + sessionID + ":" + normalized);
  }

  async* geminiSSEToOpenAISSE(source: ReadableStream<Uint8Array> | null, model: string, sessionID: string, schemas: ToolSchemaMap): AsyncGenerator<string> {
    const completionID = randomID("chatcmpl");
    let sentRole = false;
    let toolIndex = 0;
    let hasToolCalls = false;
    let sentFinal = false;
    let trackedUsage: Record<string, unknown> | null = null;
    const writeChunk = (delta: Record<string, unknown>, finish: unknown, usage: Record<string, unknown> | null): string => {
      const chunk: Record<string, unknown> = { id: completionID, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finish }] };
      if (usage) chunk["usage"] = usage;
      return "data: " + JSON.stringify(chunk) + "\n\n";
    };
    for await (const line of iterateLines(source)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const dataText = trimmed.slice(5).trim();
      if (dataText === "" || dataText === "[DONE]") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(dataText);
      } catch {
        continue;
      }
      const response = unwrapGeminiResponse(parsed);
      this.cacheSignaturesFromResponse(response, model, sessionID);
      const usage = geminiUsage(response);
      if (usage) trackedUsage = usage;
      for (const delta of geminiDeltas(response, schemas, { index: toolIndex })) {
        toolIndex = delta._toolIndex as number;
        delete delta._toolIndex;
        if (!sentRole) {
          yield writeChunk({ role: "assistant", content: "" }, null, null);
          sentRole = true;
        }
        if (delta["tool_calls"] !== undefined) hasToolCalls = true;
        yield writeChunk(delta, null, null);
      }
      const [finish, ok] = geminiFinishReason(response, hasToolCalls);
      if (ok) {
        yield writeChunk({}, finish, null);
        sentFinal = true;
      }
    }
    if (trackedUsage) {
      yield writeChunk({}, null, trackedUsage);
    }
    if (!sentFinal) {
      yield writeChunk({}, hasToolCalls ? "tool_calls" : "stop", null);
    }
    yield "data: [DONE]\n\n";
  }

  async geminiStreamToOpenAICompletion(source: ReadableStream<Uint8Array> | null, model: string, sessionID: string, schemas: ToolSchemaMap): Promise<Record<string, unknown>> {
    let content = "";
    let reasoning = "";
    const toolCalls: unknown[] = [];
    let usage: Record<string, unknown> | null = null;
    let finish = "stop";
    let toolIndex = 0;
    for await (const line of iterateLines(source)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const dataText = trimmed.slice(5).trim();
      if (dataText === "" || dataText === "[DONE]") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(dataText);
      } catch {
        continue;
      }
      const response = unwrapGeminiResponse(parsed);
      this.cacheSignaturesFromResponse(response, model, sessionID);
      for (const delta of geminiDeltas(response, schemas, { index: toolIndex })) {
        toolIndex = delta._toolIndex as number;
        delete delta._toolIndex;
        content += stringValue(delta["content"]);
        reasoning += stringValue(delta["reasoning_content"]);
        const calls = delta["tool_calls"];
        if (Array.isArray(calls)) toolCalls.push(...calls);
      }
      const nextUsage = geminiUsage(response);
      if (nextUsage) usage = nextUsage;
      const [mapped, ok] = geminiFinishReason(response, toolCalls.length > 0);
      if (ok) finish = mapped;
    }
    const message: Record<string, unknown> = { role: "assistant", content: null };
    if (content !== "") message["content"] = content;
    if (reasoning !== "") message["reasoning_content"] = reasoning;
    if (toolCalls.length > 0) {
      message["tool_calls"] = stripToolCallIndexes(toolCalls);
      finish = "tool_calls";
    }
    if (usage === null) usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    return { id: randomID("chatcmpl"), object: "chat.completion", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message, finish_reason: finish }], usage };
  }

  cacheSignaturesFromResponse(response: Record<string, unknown>, model: string, sessionID: string): void {
    const candidates = (response["candidates"] ?? []) as unknown[];
    for (const rawCandidate of candidates) {
      const candidate = (rawCandidate ?? {}) as Record<string, unknown>;
      const content = (candidate["content"] ?? {}) as Record<string, unknown>;
      const parts = (content["parts"] ?? []) as unknown[];
      for (const rawPart of parts) {
        const part = (rawPart ?? {}) as Record<string, unknown>;
        if (part["thought"] === true) {
          const text = stringValue(part["text"]);
          const signature = stringValue(part["thoughtSignature"]);
          if (text !== "" && signature !== "") {
            this.cacheSignature(model, sessionID, text, signature);
          }
        }
      }
    }
  }

  googleGenerationHeaders(accessToken: string, stream: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      authorization: "Bearer " + accessToken.trim(),
      "content-type": "application/json",
      accept: stream ? "text/event-stream" : "application/json",
    };
    if (this.userAgent !== "") headers["user-agent"] = this.userAgent;
    if (this.apiClient !== "") headers["x-goog-api-client"] = this.apiClient;
    if (this.clientMetadata !== "") headers["client-metadata"] = this.clientMetadata;
    return headers;
  }

  async fetchAccountInfo(client: HttpClient, ctx: RequestContext, accessToken: string): Promise<{ projectID: string; tier: string; email: string }> {
    const info = { projectID: "", tier: "free-tier", email: "" };
    const loadEndpoints = this.loadEndpoints.length > 0 ? this.loadEndpoints : ["https://cloudcode-pa.googleapis.com", this.endpoint];
    let currentTierPresent = false;
    const allowedTiers: unknown[] = [];
    let hadError = false;
    for (const endpoint of loadEndpoints) {
      let data: Record<string, unknown> = {};
      try {
        const resp = await client.fetch(endpoint + "/v1internal:loadCodeAssist", {
          method: "POST",
          headers: this.googleGenerationHeaders(accessToken, false),
          body: JSON.stringify({ metadata: codeAssistMetadata() }),
          signal: ctx.signal,
        });
        if (resp.status >= 200 && resp.status < 300) {
          data = (await readAllJSONSafe(resp.body)) as Record<string, unknown>;
        } else {
          hadError = true;
        }
      } catch {
        hadError = true;
        continue;
      }
      if (Object.keys(data).length === 0) continue;
      const project = extractGoogleProjectID(data);
      if (project !== "") info.projectID = project;
      if (data["currentTier"] !== undefined) currentTierPresent = true;
      const currentTierID = extractGoogleTier(data);
      if (currentTierID !== "") info.tier = currentTierID;
      const tiers = extractAllowedTiers(data);
      if (tiers.length > 0) allowedTiers.push(...tiers);
      if (currentTierID === "") {
        const detected = detectAntigravityTier(data);
        if (detected !== "") info.tier = detected;
      }
      if (info.projectID !== "") break;
    }
    if (info.projectID === "" && !currentTierPresent) {
      const onboard = await this.onboardUser(client, ctx, accessToken, info.tier, allowedTiers);
      if (onboard.projectID !== "") {
        info.projectID = onboard.projectID;
        info.tier = onboard.tier;
      }
    }
    if (this.name === "antigravity" && info.projectID === "" && hadError) {
      info.projectID = this.defaultProject;
    }
    info.email = await this.fetchGoogleEmail(client, ctx, accessToken);
    return info;
  }

  async onboardUser(client: HttpClient, ctx: RequestContext, accessToken: string, tier: string, allowedTiers: unknown[]): Promise<{ projectID: string; tier: string }> {
    if (this.name === "antigravity" && allowedTiers.length === 0) return { projectID: "", tier: "" };
    const onboardTier = selectOnboardTier(tier, allowedTiers);
    if (onboardTier === "") return { projectID: "", tier: "" };
    const onboardEndpoints = this.onboardEndpoints.length > 0 ? this.onboardEndpoints : [this.endpoint, "https://cloudcode-pa.googleapis.com"];
    const onboardRequest = JSON.stringify({ tierId: onboardTier, metadata: codeAssistMetadata() });
    for (const endpoint of onboardEndpoints) {
      let data = await this.postOnboardUser(client, ctx, accessToken, endpoint, onboardRequest);
      if (!data) continue;
      for (let i = 0; i < 30 && data["done"] === false; i++) {
        await sleep(2000);
        const polled = await this.postOnboardUser(client, ctx, accessToken, endpoint, onboardRequest);
        if (polled) data = polled;
      }
      if (data["done"] === false) continue;
      if (data["response"] && typeof data["response"] === "object") {
        data = data["response"] as Record<string, unknown>;
      }
      const project = extractGoogleProjectID(data);
      if (project !== "") {
        return { projectID: project, tier: normalizeGoogleTierID(onboardTier) };
      }
    }
    return { projectID: "", tier: "" };
  }

  async postOnboardUser(client: HttpClient, ctx: RequestContext, accessToken: string, endpoint: string, payload: string): Promise<Record<string, unknown> | null> {
    try {
      const resp = await client.fetch(endpoint + "/v1internal:onboardUser", {
        method: "POST",
        headers: this.googleGenerationHeaders(accessToken, false),
        body: payload,
        signal: ctx.signal,
      });
      if (resp.status < 200 || resp.status >= 300) return null;
      return (await readAllJSONSafe(resp.body)) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  async fetchGoogleEmail(client: HttpClient, ctx: RequestContext, accessToken: string): Promise<string> {
    try {
      const resp = await client.fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        method: "GET",
        headers: this.googleGenerationHeaders(accessToken, false),
        signal: ctx.signal,
      });
      if (resp.status < 200 || resp.status >= 300) return "";
      const data = (await readAllJSONSafe(resp.body)) as Record<string, unknown>;
      return stringValue(data["email"]);
    } catch {
      return "";
    }
  }
}

export function antigravityDelegateConfig(registry: Registry | null, db: ProxyDB | null, redis: Redis | null): ConstructorParameters<typeof GoogleCodeAssistProvider>[0] {
  return {
    name: "antigravity",
    clientID: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
    clientSecret: "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",
    endpoint: "https://daily-cloudcode-pa.googleapis.com",
    endpoints: ["https://daily-cloudcode-pa.googleapis.com", "https://autopush-cloudcode-pa.sandbox.googleapis.com", "https://cloudcode-pa.googleapis.com"],
    loadEndpoints: ["https://cloudcode-pa.googleapis.com", "https://daily-cloudcode-pa.googleapis.com"],
    onboardEndpoints: ["https://daily-cloudcode-pa.googleapis.com", "https://cloudcode-pa.googleapis.com"],
    refreshBufferMs: 3600 * 1000,
    defaultProject: "rising-fact-p41fc",
    userAgent: antigravityUserAgent + "linux/x64",
    apiClient: "google-cloud-sdk vscode_cloudshelleditor/0.1",
    clientMetadata: '{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}',
    registry,
    db,
    redis,
  };
}

export class AntigravityProvider implements Provider {
  private delegate: GoogleCodeAssistProvider;
  constructor(registry: Registry | null, db: ProxyDB | null, redis: Redis | null) {
    this.delegate = new GoogleCodeAssistProvider(antigravityDelegateConfig(registry, db, redis));
  }

  refreshBuffer(): number {
    return this.delegate.refreshBuffer();
  }

  refreshCredentials(ctx: RequestContext, client: HttpClient, refreshToken: string, account: ProviderAccountLike): Promise<RefreshedCredentials> {
    return this.delegate.refreshCredentials(ctx, client, refreshToken, account);
  }

  makeRequest(client: HttpClient, ctx: RequestContext, credentials: string, account: ProviderAccountLike, body: Record<string, unknown>, stream: boolean): Promise<UpstreamResponse> {
    return this.delegate.makeRequest(client, ctx, credentials, account, body, stream);
  }
}

export function isAntigravityProjectContextError(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes("#3501") ||
    (lower.includes("google cloud project") && lower.includes("code assist license")) ||
    lower.includes("invalid project resource name projects/") ||
    (lower.includes("resource projects/") && lower.includes("could not be found")) ||
    (lower.includes("project") && lower.includes("not found"));
}

function normalizedThinkingMap(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const budget = numberFromAny(defaultAny(record["thinkingBudget"], record["thinking_budget"]));
  if (budget > 0) out["thinkingBudget"] = budget;
  const level = defaultStringValue(record["thinkingLevel"], stringValue(record["thinking_level"]));
  if (level !== "") out["thinkingLevel"] = level.toLowerCase();
  const include = defaultAny(record["includeThoughts"], record["include_thoughts"]);
  if (typeof include === "boolean") out["include_thoughts"] = include;
  if (Object.keys(out).length === 0) return null;
  return out;
}

function defaultBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function isGemini3ModelName(model: string): boolean {
  return lastModelSegment(model).toLowerCase().startsWith("gemini-3");
}

function geminiThinkingLevelFromModel(model: string): string {
  const m = lastModelSegment(model).toLowerCase();
  for (const level of ["minimal", "low", "medium", "high"]) {
    if (m.endsWith("-" + level)) return level;
  }
  return "";
}

function trimGeminiThinkingLevelSuffix(model: string): string {
  const lower = model.toLowerCase();
  for (const suffix of ["-minimal", "-low", "-medium", "-high"]) {
    if (lower.endsWith(suffix)) return model.slice(0, -suffix.length);
  }
  return model;
}

function ensureToolConfig(payload: Record<string, unknown>): void {
  let toolConfig = (payload["toolConfig"] ?? {}) as Record<string, unknown>;
  if (Object.keys(toolConfig).length === 0) {
    toolConfig = {};
    payload["toolConfig"] = toolConfig;
  }
  let calling = (toolConfig["functionCallingConfig"] ?? {}) as Record<string, unknown>;
  if (Object.keys(calling).length === 0) {
    calling = {};
    toolConfig["functionCallingConfig"] = calling;
  }
  calling["mode"] = "VALIDATED";
}

function normalizeClaudeTools(payload: Record<string, unknown>): void {
  const tools = (payload["tools"] ?? []) as unknown[];
  for (const rawTool of tools) {
    const tool = (rawTool ?? {}) as Record<string, unknown>;
    const decls = (tool["functionDeclarations"] ?? []) as unknown[];
    for (const rawDecl of decls) {
      const decl = (rawDecl ?? {}) as Record<string, unknown>;
      if (decl["parametersJsonSchema"] !== undefined) {
        decl["parameters"] = decl["parametersJsonSchema"];
        delete decl["parametersJsonSchema"];
      }
      let params = (decl["parameters"] ?? null) as Record<string, unknown> | null;
      if (!params) params = { type: "object", properties: {} };
      params = sanitizeAntigravityClaudeToolSchema(params);
      if (params["type"] === undefined) params["type"] = "object";
      if (params["properties"] === undefined) params["properties"] = {};
      if (params["required"] === undefined) params["required"] = [];
      decl["parameters"] = params;
    }
  }
}

function sanitizeGeminiToolNames(payload: Record<string, unknown>): void {
  const tools = (payload["tools"] ?? []) as unknown[];
  for (const rawTool of tools) {
    const tool = (rawTool ?? {}) as Record<string, unknown>;
    const decls = (tool["functionDeclarations"] ?? []) as unknown[];
    for (const rawDecl of decls) {
      const decl = (rawDecl ?? {}) as Record<string, unknown>;
      decl["name"] = sanitizedToolName(stringValue(decl["name"]));
    }
  }
}

function augmentToolDescriptions(payload: Record<string, unknown>): void {
  const tools = (payload["tools"] ?? []) as unknown[];
  for (const rawTool of tools) {
    const tool = (rawTool ?? {}) as Record<string, unknown>;
    const decls = (tool["functionDeclarations"] ?? []) as unknown[];
    for (const rawDecl of decls) {
      const decl = (rawDecl ?? {}) as Record<string, unknown>;
      let description = stringValue(decl["description"]);
      if (description.includes("STRICT PARAMETERS:")) continue;
      let params = (decl["parameters"] ?? null) as Record<string, unknown> | null;
      if (!params) params = (decl["parametersJsonSchema"] ?? null) as Record<string, unknown> | null;
      if (!params) continue;
      const summary = strictParamsSummary(params);
      if (summary === "") continue;
      decl["description"] = description !== "" ? description.trim() + "\n\nSTRICT PARAMETERS: " + summary : "STRICT PARAMETERS: " + summary;
    }
  }
}

export function injectGeminiToolInstruction(payload: Record<string, unknown>): void {
  if (!hasFunctionTools(payload)) return;
  const existing = payload["systemInstruction"];
  if (typeof existing === "string") {
    if (existing.includes("<CRITICAL_TOOL_USAGE_INSTRUCTIONS>")) return;
    const text = existing.trim();
    payload["systemInstruction"] = { parts: [{ text: text !== "" ? geminiToolSchemaSystemInstruction + "\n\n" + text : geminiToolSchemaSystemInstruction }] };
    return;
  }
  if (existing && typeof existing === "object") {
    const record = existing as Record<string, unknown>;
    const parts = (record["parts"] ?? []) as unknown[];
    if (parts.some((p) => stringValue((p as Record<string, unknown>)["text"]).includes("<CRITICAL_TOOL_USAGE_INSTRUCTIONS>"))) return;
    record["parts"] = [{ text: geminiToolSchemaSystemInstruction }, ...parts];
    payload["systemInstruction"] = record;
    return;
  }
  payload["systemInstruction"] = { parts: [{ text: geminiToolSchemaSystemInstruction }] };
}

function hasFunctionTools(payload: Record<string, unknown>): boolean {
  for (const rawTool of (payload["tools"] ?? []) as unknown[]) {
    const tool = (rawTool ?? {}) as Record<string, unknown>;
    if (((tool["functionDeclarations"] ?? []) as unknown[]).length > 0) return true;
  }
  return false;
}

function strictParamsSummary(schema: Record<string, unknown>): string {
  const props = (schema["properties"] ?? {}) as Record<string, unknown>;
  if (stringValue(schema["type"]) !== "object" || Object.keys(props).length === 0) {
    return "(schema missing top-level object properties)";
  }
  const required = new Set<string>();
  for (const raw of (schema["required"] ?? []) as unknown[]) {
    const key = stringValue(raw);
    if (key !== "") required.add(key);
  }
  const requiredKeys: string[] = [];
  const optionalKeys: string[] = [];
  for (const key of Object.keys(props)) {
    if (required.has(key)) requiredKeys.push(key);
    else optionalKeys.push(key);
  }
  requiredKeys.sort();
  optionalKeys.sort();
  const ordered = [...requiredKeys, ...optionalKeys];
  const parts: string[] = [];
  for (const key of ordered) {
    const prop = (props[key] ?? {}) as Record<string, unknown>;
    let typ = summarizeSchema(prop, 2);
    if (required.has(key)) typ += " REQUIRED";
    parts.push(key + ": " + typ);
  }
  const summary = parts.join(", ");
  if (summary.length > 900) return summary.slice(0, 900) + "...";
  return summary;
}

function summarizeSchema(schema: Record<string, unknown> | null, depth: number): string {
  if (!schema) return "unknown";
  let typ = normalizeSchemaType(schema["type"]);
  if (typ === "") typ = "unknown";
  if (typ === "array") {
    const items = (schema["items"] ?? null) as Record<string, unknown> | null;
    const itemSummary = depth > 0 ? summarizeSchema(items, depth - 1) : "unknown";
    return "array[" + itemSummary + "]";
  }
  if (typ === "object") {
    const props = (schema["properties"] ?? {}) as Record<string, unknown>;
    if (Object.keys(props).length === 0 || depth <= 0) return "object";
    const required = new Set<string>();
    for (const raw of (schema["required"] ?? []) as unknown[]) {
      const key = stringValue(raw);
      if (key !== "") required.add(key);
    }
    const keys = Object.keys(props);
    keys.sort((a, b) => {
      if (required.has(a) !== required.has(b)) return required.has(a) ? -1 : 1;
      return a.localeCompare(b);
    });
    const shown = keys.slice(0, 8);
    const parts: string[] = [];
    for (const key of shown) {
      const prop = (props[key] ?? {}) as Record<string, unknown>;
      let text = key + ": " + summarizeSchema(prop, depth - 1);
      if (required.has(key)) text += " REQUIRED";
      parts.push(text);
    }
    let extra = "";
    if (keys.length > shown.length) extra = `, ...+${keys.length - shown.length}`;
    return "{" + parts.join(", ") + extra + "}";
  }
  const enumValues = (schema["enum"] ?? []) as unknown[];
  if (enumValues.length > 0) {
    const preview = enumValues.slice(0, 6).map((v) => String(v));
    const suffix = enumValues.length > 6 ? "|..." : "";
    return typ + " enum(" + preview.join("|") + suffix + ")";
  }
  return typ;
}

function normalizeSchemaType(value: unknown): string {
  if (typeof value === "string" && value !== "") return value;
  if (Array.isArray(value)) {
    for (const raw of value) {
      const text = stringValue(raw);
      if (text !== "" && text !== "null") return text;
    }
    if (value.length > 0) return stringValue(value[0]);
  }
  return "";
}

function sanitizeToolBlocks(contents: unknown[]): unknown[] {
  const callIDs = new Set<string>();
  const responseIDs = new Set<string>();
  for (const rawContent of contents) {
    const content = (rawContent ?? {}) as Record<string, unknown>;
    for (const rawPart of (content["parts"] ?? []) as unknown[]) {
      const part = (rawPart ?? {}) as Record<string, unknown>;
      const fn = part["functionCall"];
      if (fn && typeof fn === "object") {
        const id = stringValue((fn as Record<string, unknown>)["id"]);
        if (id !== "") callIDs.add(id);
      }
      const fr = part["functionResponse"];
      if (fr && typeof fr === "object") {
        const id = stringValue((fr as Record<string, unknown>)["id"]);
        if (id !== "") responseIDs.add(id);
      }
    }
  }
  const out: unknown[] = [];
  for (const rawContent of contents) {
    const content = (rawContent ?? {}) as Record<string, unknown>;
    const parts: unknown[] = [];
    for (const rawPart of (content["parts"] ?? []) as unknown[]) {
      const part = (rawPart ?? {}) as Record<string, unknown>;
      const fn = part["functionCall"];
      if (fn && typeof fn === "object") {
        if (!responseIDs.has(stringValue((fn as Record<string, unknown>)["id"]))) continue;
      }
      const fr = part["functionResponse"];
      if (fr && typeof fr === "object") {
        if (!callIDs.has(stringValue((fr as Record<string, unknown>)["id"]))) continue;
      }
      parts.push(rawPart);
    }
    if (parts.length > 0) {
      const copyContent = cloneAnyMap(content);
      copyContent["parts"] = parts;
      out.push(copyContent);
    }
  }
  return out;
}

const toolArtifactMarker = /^\s*(Tool:\s*\w+|(?:thought|think)\s*:)/i;

function scrubConversationArtifacts(content: Record<string, unknown>): void {
  const parts = (content["parts"] ?? []) as unknown[];
  for (const rawPart of parts) {
    const part = (rawPart ?? {}) as Record<string, unknown>;
    const text = stringValue(part["text"]);
    if (text === "") continue;
    part["text"] = scrubToolTranscriptArtifacts(text);
  }
}

export function scrubToolTranscriptArtifacts(text: string): string {
  const lines = text.split("\n");
  const output: string[] = [];
  let inFence = false;
  let fenceStart = "";
  let fenceLines: string[] = [];
  const flushFence = (end: string) => {
    const cleaned: string[] = [];
    let hadMarker = false;
    for (const line of fenceLines) {
      if (toolArtifactMarker.test(line)) {
        hadMarker = true;
        continue;
      }
      cleaned.push(line);
    }
    const hasContent = cleaned.some((l) => l.trim() !== "");
    if (!hadMarker || hasContent) {
      output.push(fenceStart);
      output.push(...cleaned);
      output.push(end);
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
    if (toolArtifactMarker.test(line)) continue;
    output.push(line);
  }
  if (inFence) {
    output.push(fenceStart);
    output.push(...fenceLines);
  }
  let cleaned = output.join("\n");
  while (cleaned.includes("\n\n\n\n")) {
    cleaned = cleaned.split("\n\n\n\n").join("\n\n\n");
  }
  return cleaned;
}

function codeAssistMetadata(): Record<string, unknown> {
  return { ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" };
}

function extractGoogleProjectID(data: Record<string, unknown>): string {
  const value = stringValue(data["cloudaicompanionProject"]);
  if (value !== "") return value;
  const project = data["cloudaicompanionProject"];
  if (project && typeof project === "object") {
    return stringValue((project as Record<string, unknown>)["id"]);
  }
  return "";
}

function extractGoogleTier(data: Record<string, unknown>): string {
  const value = stringValue(data["currentTier"]);
  if (value !== "") return normalizeGoogleTierID(value);
  const tier = data["currentTier"];
  if (tier && typeof tier === "object") {
    const id = stringValue((tier as Record<string, unknown>)["id"]);
    if (id !== "") return normalizeGoogleTierID(id);
    return normalizeGoogleTierID(stringValue((tier as Record<string, unknown>)["name"]));
  }
  return "";
}

function extractAllowedTiers(data: Record<string, unknown>): unknown[] {
  const items = (data["allowedTiers"] ?? []) as unknown[];
  return items.filter((item) => item && typeof item === "object");
}

function detectAntigravityTier(data: Record<string, unknown>): string {
  let detected = "";
  for (const raw of extractAllowedTiers(data)) {
    const tier = raw as Record<string, unknown>;
    if (tier["isDefault"] === true) {
      detected = normalizeGoogleTierID(stringValue(tier["id"]));
      break;
    }
  }
  const paidTier = data["paidTier"];
  if (paidTier && typeof paidTier === "object") {
    const id = normalizeGoogleTierID(stringValue((paidTier as Record<string, unknown>)["id"]));
    if (id !== "" && isPaidGoogleTierID(id)) return id;
  }
  return detected;
}

function selectOnboardTier(fallback: string, allowedTiers: unknown[]): string {
  for (const raw of allowedTiers) {
    const tier = raw as Record<string, unknown>;
    if (tier["isDefault"] === true) {
      const id = stringValue(tier["id"]);
      if (id !== "") return id;
    }
  }
  for (const raw of allowedTiers) {
    const tier = raw as Record<string, unknown>;
    if (stringValue(tier["id"]) === "legacy-tier") return "legacy-tier";
  }
  if (allowedTiers.length > 0) {
    return stringValue((allowedTiers[0] as Record<string, unknown>)["id"]);
  }
  if (fallback !== "") return fallback;
  return "free-tier";
}

function normalizeGoogleTierID(id: string): string {
  return id.trim().toLowerCase();
}

function isPaidGoogleTierID(id: string): boolean {
  const lower = normalizeGoogleTierID(id);
  return lower === "paid" || lower === "standard-tier";
}

export function openAIToGemini(body: Record<string, unknown>): Record<string, unknown> {
  const messages = (body["messages"] ?? []) as unknown[];
  let contents: unknown[] = [];
  const systemParts: unknown[] = [];
  const completedToolCallIDs = completedToolCallIDsFn(messages);
  const toolUseIDs = toolUseIDsFn(messages);
  const validToolResultIDs = validToolResultIDsFn(messages);
  for (const raw of messages) {
    const msg = (raw ?? {}) as Record<string, unknown>;
    const role = stringValue(msg["role"]);
    if (role === "system" || role === "developer") {
      systemParts.push(...openAIContentTextParts(msg["content"]));
      continue;
    }
    let parts = openAIContentToGeminiParts(msg["content"]);
    parts = parts.concat(openAIToolCallsToGeminiParts(msg, completedToolCallIDs));
    if (role === "tool") {
      const toolCallID = stringValue(msg["tool_call_id"]);
      if (toolCallID === "" || !validToolResultIDs[toolCallID] || !toolUseIDs[toolCallID]) continue;
      parts = [{ functionResponse: { name: defaultStringValue(msg["name"], "unknown"), id: toolCallID, response: { result: msg["content"] } } }];
    }
    const geminiRole = role === "assistant" ? "model" : "user";
    if (parts.length > 0) {
      contents.push({ role: geminiRole, parts });
    }
  }
  contents = separateTextAndToolParts(groupConsecutiveToolResponses(sanitizeGeminiContents(contents)));
  const payload: Record<string, unknown> = { contents };
  if (systemParts.length > 0) {
    payload["systemInstruction"] = { parts: systemParts };
  }
  const generation: Record<string, unknown> = {};
  if (body["temperature"] !== undefined && body["temperature"] !== null) generation["temperature"] = body["temperature"];
  if (body["top_p"] !== undefined && body["top_p"] !== null) generation["topP"] = body["top_p"];
  if (body["max_tokens"] !== undefined && body["max_tokens"] !== null) generation["maxOutputTokens"] = body["max_tokens"];
  if (body["stop"] !== undefined && body["stop"] !== null) {
    if (Array.isArray(body["stop"])) {
      generation["stopSequences"] = body["stop"];
    } else if (stringValue(body["stop"]) !== "") {
      generation["stopSequences"] = [body["stop"]];
    }
  }
  const thinking = requestThinkingConfig(body);
  if (Object.keys(thinking).length > 0) generation["thinkingConfig"] = thinking;
  if (Object.keys(generation).length > 0) payload["generationConfig"] = generation;
  const tools = geminiTools(body["tools"]);
  if (tools.length > 0) {
    payload["tools"] = [{ functionDeclarations: tools }];
  }
  for (const key of ["cached_content", "cachedContent", "extra_body", "system_instruction"]) {
    if (body[key] !== undefined && body[key] !== null) payload[key] = body[key];
  }
  payload["safetySettings"] = [
    { category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" },
    { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "OFF" },
    { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "OFF" },
    { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "OFF" },
  ];
  return payload;
}

function openAIContentTextParts(content: unknown): unknown[] {
  if (typeof content === "string") return [{ text: content }];
  const parts: unknown[] = [];
  for (const raw of (Array.isArray(content) ? content : [])) {
    const item = (raw ?? {}) as Record<string, unknown>;
    if (item["type"] !== "text") continue;
    const text = stringValue(item["text"]);
    if (text !== "") parts.push({ text });
  }
  return parts;
}

function completedToolCallIDsFn(messages: unknown[]): Record<string, boolean> {
  const ids: Record<string, boolean> = {};
  for (const raw of messages) {
    const msg = (raw ?? {}) as Record<string, unknown>;
    if (stringValue(msg["role"]) === "tool") {
      const id = stringValue(msg["tool_call_id"]);
      if (id !== "") ids[id] = true;
    }
    if (stringValue(msg["role"]) === "user") {
      for (const rawBlock of (Array.isArray(msg["content"]) ? msg["content"] : [])) {
        const block = (rawBlock ?? {}) as Record<string, unknown>;
        if (block["type"] === "tool_result") {
          const id = stringValue(block["tool_use_id"]);
          if (id !== "") ids[id] = true;
        }
      }
    }
  }
  return ids;
}

function toolUseIDsFn(messages: unknown[]): Record<string, boolean> {
  const ids: Record<string, boolean> = {};
  for (const raw of messages) {
    const msg = (raw ?? {}) as Record<string, unknown>;
    if (stringValue(msg["role"]) !== "assistant") continue;
    for (const rawCall of (Array.isArray(msg["tool_calls"]) ? msg["tool_calls"] : [])) {
      const call = (rawCall ?? {}) as Record<string, unknown>;
      const id = stringValue(call["id"]);
      if (id !== "") ids[id] = true;
    }
  }
  return ids;
}

function validToolResultIDsFn(messages: unknown[]): Record<string, boolean> {
  const valid: Record<string, boolean> = {};
  let lastAssistantToolCallIDs: Record<string, boolean> = {};
  for (const raw of messages) {
    const msg = (raw ?? {}) as Record<string, unknown>;
    const role = stringValue(msg["role"]);
    switch (role) {
      case "assistant":
        lastAssistantToolCallIDs = {};
        for (const rawCall of (Array.isArray(msg["tool_calls"]) ? msg["tool_calls"] : [])) {
          const call = (rawCall ?? {}) as Record<string, unknown>;
          const id = stringValue(call["id"]);
          if (id !== "") lastAssistantToolCallIDs[id] = true;
        }
        break;
      case "tool": {
        const id = stringValue(msg["tool_call_id"]);
        if (id !== "" && lastAssistantToolCallIDs[id]) valid[id] = true;
        break;
      }
      case "user": {
        let hasToolResults = false;
        for (const rawBlock of (Array.isArray(msg["content"]) ? msg["content"] : [])) {
          const block = (rawBlock ?? {}) as Record<string, unknown>;
          if (block["type"] !== "tool_result") continue;
          hasToolResults = true;
          const id = stringValue(block["tool_use_id"]);
          if (id !== "" && lastAssistantToolCallIDs[id]) valid[id] = true;
        }
        if (!hasToolResults) lastAssistantToolCallIDs = {};
        break;
      }
      case "system":
      case "developer":
        lastAssistantToolCallIDs = {};
        break;
    }
  }
  return valid;
}

function openAIToolCallsToGeminiParts(msg: Record<string, unknown>, completed: Record<string, boolean>): unknown[] {
  const parts: unknown[] = [];
  for (const rawCall of (Array.isArray(msg["tool_calls"]) ? msg["tool_calls"] : [])) {
    const call = (rawCall ?? {}) as Record<string, unknown>;
    const id = stringValue(call["id"]);
    if (id !== "" && !completed[id]) continue;
    const fn = (call["function"] ?? {}) as Record<string, unknown>;
    const name = stringValue(fn["name"]);
    if (name === "") continue;
    let args: Record<string, unknown> = {};
    const rawArgs = stringValue(fn["arguments"]);
    if (rawArgs !== "") {
      try {
        args = JSON.parse(rawArgs) as Record<string, unknown>;
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
    const content = (rawContent ?? {}) as Record<string, unknown>;
    for (const rawPart of (content["parts"] ?? []) as unknown[]) {
      const part = (rawPart ?? {}) as Record<string, unknown>;
      const fn = part["functionCall"];
      if (fn && typeof fn === "object") {
        const id = stringValue((fn as Record<string, unknown>)["id"]);
        if (id !== "") callIdx.set(id, idx);
      }
      const fr = part["functionResponse"];
      if (fr && typeof fr === "object") {
        const id = stringValue((fr as Record<string, unknown>)["id"]);
        if (id !== "") responseIdx.set(id, idx);
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
    const content = (rawContent ?? {}) as Record<string, unknown>;
    const parts: unknown[] = [];
    for (const rawPart of (content["parts"] ?? []) as unknown[]) {
      const part = (rawPart ?? {}) as Record<string, unknown>;
      const fn = part["functionCall"];
      if (fn && typeof fn === "object") {
        if (!validCalls.has(stringValue((fn as Record<string, unknown>)["id"]))) continue;
      }
      const fr = part["functionResponse"];
      if (fr && typeof fr === "object") {
        if (!validResponses.has(stringValue((fr as Record<string, unknown>)["id"]))) continue;
      }
      parts.push(rawPart);
    }
    if (parts.length > 0) {
      const copyContent = cloneAnyMap(content);
      copyContent["parts"] = parts;
      out.push(copyContent);
    }
  }
  return out;
}

function groupConsecutiveToolResponses(contents: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const rawContent of contents) {
    const content = (rawContent ?? {}) as Record<string, unknown>;
    const parts = (content["parts"] ?? []) as unknown[];
    if (content["role"] === "user" && hasFunctionResponsePart(parts) && out.length > 0) {
      const last = (out[out.length - 1] ?? {}) as Record<string, unknown>;
      const lastParts = (last["parts"] ?? []) as unknown[];
      if (last["role"] === "user" && hasFunctionResponsePart(lastParts)) {
        last["parts"] = [...lastParts, ...parts];
        continue;
      }
    }
    const copyContent = cloneAnyMap(content);
    copyContent["parts"] = [...parts];
    out.push(copyContent);
  }
  return out;
}

function hasFunctionResponsePart(parts: unknown[]): boolean {
  for (const rawPart of parts) {
    const part = (rawPart ?? {}) as Record<string, unknown>;
    if (part["functionResponse"] !== undefined) return true;
  }
  return false;
}

function separateTextAndToolParts(contents: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const rawContent of contents) {
    const content = (rawContent ?? {}) as Record<string, unknown>;
    const parts = (content["parts"] ?? []) as unknown[];
    if (parts.length === 0) {
      out.push(rawContent);
      continue;
    }
    const [textParts, thoughtParts, callParts, responseParts, otherParts] = splitGeminiParts(parts);
    switch (content["role"]) {
      case "model":
        if (callParts.length > 0 && textParts.length + thoughtParts.length > 0) {
          appendContentParts(out, content, [...thoughtParts, ...textParts, ...otherParts]);
          appendContentParts(out, content, callParts);
        } else {
          out.push(rawContent);
        }
        break;
      case "user":
        if (responseParts.length > 0) {
          appendContentParts(out, content, [...responseParts, ...otherParts]);
        } else {
          out.push(rawContent);
        }
        break;
      default:
        out.push(rawContent);
        break;
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
    const part = (rawPart ?? {}) as Record<string, unknown>;
    if (part["functionCall"] !== undefined) callParts.push(rawPart);
    else if (part["functionResponse"] !== undefined) responseParts.push(rawPart);
    else if (part["thought"] === true) thoughtParts.push(rawPart);
    else if (part["text"] !== undefined) textParts.push(rawPart);
    else otherParts.push(rawPart);
  }
  return [textParts, thoughtParts, callParts, responseParts, otherParts];
}

function appendContentParts(target: unknown[], content: Record<string, unknown>, parts: unknown[]): void {
  if (parts.length === 0) return;
  const copyContent = cloneAnyMap(content);
  copyContent["parts"] = parts;
  target.push(copyContent);
}

function requestThinkingConfig(body: Record<string, unknown>): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  const budget = numberFromAny(body["thinking_budget"]);
  const effort = defaultStringValue(reasoningEffort(body["reasoning"]), stringValue(body["reasoning_effort"]));
  if (budget > 0) {
    config["thinkingBudget"] = budget;
  } else if (effort !== "" && effort !== "none") {
    const b = defaultThinkingBudget(effort);
    if (b > 0) config["thinkingBudget"] = b;
  }
  if (Object.keys(config).length > 0 && body["include_thoughts"] !== undefined) {
    config["include_thoughts"] = body["include_thoughts"];
  }
  return config;
}

function reasoningEffort(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  return stringValue((value as Record<string, unknown>)["effort"]);
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

const antigravitySystemInstruction = "You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.**Absolute paths only****Proactiveness**";

function fallbackAntigravitySystemInstructionModel(model: string): boolean {
  const normalizedModel = lastModelSegment(model).toLowerCase();
  if (normalizedModel.includes("image")) return false;
  return normalizedModel.includes("claude") || isGemini3ModelName(normalizedModel);
}

function openAIContentToGeminiParts(content: unknown): unknown[] {
  if (content === undefined || content === null) return [];
  if (typeof content === "string") return [{ text: content }];
  if (!Array.isArray(content)) return [];
  const parts: unknown[] = [];
  for (const raw of content) {
    const item = (raw ?? {}) as Record<string, unknown>;
    const text = stringValue(item["text"]);
    if (text !== "") {
      parts.push({ text });
      continue;
    }
    if (item["type"] === "image_url") {
      const imageURL = (item["image_url"] ?? {}) as Record<string, unknown>;
      const url = stringValue(imageURL["url"]);
      const part = dataURIToGeminiPart(url);
      if (part) {
        parts.push(part);
      } else if (url !== "") {
        parts.push({ fileData: { fileUri: url, mimeType: inferMimeTypeFromURL(url) } });
      }
    }
  }
  return parts;
}

function inferMimeTypeFromURL(value: string): string {
  try {
    const parsed = new URL(value);
    const segments = parsed.pathname.toLowerCase().split(".");
    const ext = segments[segments.length - 1] ?? "";
    const map: Record<string, string> = {
      png: "image/png",
      gif: "image/gif",
      webp: "image/webp",
      svg: "image/svg+xml",
      bmp: "image/bmp",
      ico: "image/x-icon",
      tiff: "image/tiff",
      tif: "image/tiff",
      pdf: "application/pdf",
      mp4: "video/mp4",
      webm: "video/webm",
      mov: "video/quicktime",
      avi: "video/x-msvideo",
      mp3: "audio/mpeg",
      wav: "audio/wav",
      ogg: "audio/ogg",
    };
    return map[ext] ?? "image/jpeg";
  } catch {
    return "image/jpeg";
  }
}

function dataURIToGeminiPart(value: string): Record<string, unknown> | null {
  if (!value.startsWith("data:")) return null;
  const comma = value.indexOf(",");
  if (comma === -1) return null;
  const meta = value.slice("data:".length, comma);
  let mimeType = meta.split(";")[0] ?? "";
  if (mimeType === "") mimeType = "image/png";
  return { inlineData: { mimeType, data: value.slice(comma + 1) } };
}

function geminiTools(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return [];
  const out: unknown[] = [];
  for (const item of raw) {
    const tool = (item ?? {}) as Record<string, unknown>;
    const fn = (tool["function"] ?? {}) as Record<string, unknown>;
    const name = stringValue(fn["name"]);
    if (name === "") continue;
    let params = fn["parameters"];
    if (typeof params !== "object" || params === null) {
      params = { type: "object", properties: {} };
    }
    params = sanitizeGoogleFunctionSchema(params as Record<string, unknown>);
    out.push({ name, description: defaultStringValue(fn["description"], ""), parameters: params });
  }
  return out;
}

function sanitizeGoogleFunctionSchema(schema: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!schema) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    switch (key) {
      case "type": {
        const typ = normalizeSchemaType(value);
        if (typ !== "") out["type"] = typ;
        break;
      }
      case "properties": {
        const props = value as Record<string, unknown>;
        if (!props || Object.keys(props).length === 0) continue;
        const cleaned: Record<string, unknown> = {};
        for (const [name, rawProp] of Object.entries(props)) {
          if (rawProp && typeof rawProp === "object") {
            cleaned[name] = sanitizeGoogleFunctionSchema(rawProp as Record<string, unknown>);
          }
        }
        if (Object.keys(cleaned).length > 0) out["properties"] = cleaned;
        break;
      }
      case "items": {
        if (value && typeof value === "object") {
          out["items"] = sanitizeGoogleFunctionSchema(value as Record<string, unknown>);
        }
        break;
      }
      case "anyOf": {
        const items: unknown[] = [];
        for (const rawItem of (Array.isArray(value) ? value : [])) {
          if (rawItem && typeof rawItem === "object") {
            items.push(sanitizeGoogleFunctionSchema(rawItem as Record<string, unknown>));
          }
        }
        if (items.length > 0) out["anyOf"] = items;
        break;
      }
      case "description":
      case "format":
      case "nullable":
      case "enum":
      case "required":
      case "propertyOrdering":
      case "minimum":
      case "maximum":
      case "minItems":
      case "maxItems":
      case "minLength":
      case "maxLength":
      case "pattern":
      case "title":
      case "default":
      case "example":
      case "minProperties":
      case "maxProperties":
        out[key] = value;
        break;
    }
  }
  if (schemaTypeAllowsNull(schema["type"]) && out["nullable"] === undefined) {
    out["nullable"] = true;
  }
  if (schema["const"] !== undefined && out["enum"] === undefined) {
    out["enum"] = [schema["const"]];
  }
  if (out["type"] === undefined) {
    if (out["properties"] !== undefined) out["type"] = "object";
    else if (out["items"] !== undefined) out["type"] = "array";
  }
  return out;
}

function sanitizeAntigravityClaudeToolSchema(schema: Record<string, unknown> | null): Record<string, unknown> {
  if (!schema) return { type: "object", properties: {}, required: [] };
  schema = flattenAntigravityClaudeUnion(schema);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    switch (key) {
      case "type": {
        const typ = normalizeSchemaType(value);
        if (typ !== "") out["type"] = typ;
        break;
      }
      case "properties": {
        const props = value as Record<string, unknown>;
        const cleaned: Record<string, unknown> = {};
        if (props) {
          for (const [name, rawProp] of Object.entries(props)) {
            if (rawProp && typeof rawProp === "object") {
              cleaned[name] = sanitizeAntigravityClaudeToolSchema(rawProp as Record<string, unknown>);
            }
          }
        }
        out["properties"] = cleaned;
        break;
      }
      case "items": {
        if (value && typeof value === "object") {
          out["items"] = sanitizeAntigravityClaudeToolSchema(value as Record<string, unknown>);
        }
        break;
      }
      case "description":
      case "enum":
        out[key] = value;
        break;
    }
  }
  if (schema["const"] !== undefined && out["enum"] === undefined) {
    out["enum"] = [schema["const"]];
  }
  if (out["type"] === undefined) {
    out["type"] = inferAntigravityClaudeSchemaType(out);
  }
  if (out["type"] === "object") {
    const props = (out["properties"] ?? {}) as Record<string, unknown>;
    out["properties"] = props;
    out["required"] = filteredSchemaRequired(schema["required"], props);
  }
  if (out["type"] === "array" && out["items"] === undefined) {
    out["items"] = {};
  }
  return out;
}

function flattenAntigravityClaudeUnion(schema: Record<string, unknown>): Record<string, unknown> {
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const options = (schema[key] ?? []) as unknown[];
    if (options.length === 0) continue;
    const parsedOptions = options.filter((o): o is Record<string, unknown> => !!o && typeof o === "object");
    const [mergedEnum, enumOK] = enumFromSchemaUnion(parsedOptions);
    const base = cloneSchemaWithoutUnions(schema);
    if (enumOK) {
      base["enum"] = mergedEnum;
      if (base["type"] === undefined) base["type"] = inferEnumType(mergedEnum);
      return base;
    }
    const best = bestSchemaUnionOption(parsedOptions);
    for (const [baseKey, baseValue] of Object.entries(base)) {
      if (!(baseKey in best)) best[baseKey] = baseValue;
    }
    return best;
  }
  return schema;
}

function enumFromSchemaUnion(options: Array<Record<string, unknown>>): [unknown[], boolean] {
  const values: unknown[] = [];
  for (const option of options) {
    if (normalizeSchemaType(option["type"]) === "null") continue;
    if (option["const"] !== undefined) {
      values.push(option["const"]);
      continue;
    }
    const enumValues = (option["enum"] ?? []) as unknown[];
    if (enumValues.length > 0) {
      values.push(...enumValues);
      continue;
    }
    return [[], false];
  }
  return [values, values.length > 0];
}

function bestSchemaUnionOption(options: Array<Record<string, unknown>>): Record<string, unknown> {
  let best: Record<string, unknown> = {};
  let bestScore = -1;
  for (const option of options) {
    if (normalizeSchemaType(option["type"]) === "null") continue;
    const score = schemaUnionOptionScore(option);
    if (score > bestScore) {
      bestScore = score;
      best = cloneAnyMap(option);
    }
  }
  if (bestScore === -1 && options.length > 0) best = cloneAnyMap(options[0]!);
  return best;
}

function schemaUnionOptionScore(schema: Record<string, unknown>): number {
  switch (normalizeSchemaType(schema["type"])) {
    case "object": {
      const props = schema["properties"] as Record<string, unknown>;
      return props && Object.keys(props).length > 0 ? 60 : 50;
    }
    case "array":
      return schema["items"] !== undefined ? 45 : 40;
    case "string":
      return (schema["enum"] as unknown[])?.length > 0 ? 35 : 30;
    case "number":
    case "integer":
      return 20;
    case "boolean":
      return 10;
  }
  if (schema["properties"] !== undefined) return 55;
  if (schema["items"] !== undefined) return 42;
  if (schema["const"] !== undefined || schema["enum"] !== undefined) return 32;
  return 1;
}

function cloneSchemaWithoutUnions(schema: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "anyOf" || key === "oneOf" || key === "allOf") continue;
    out[key] = value;
  }
  return out;
}

function filteredSchemaRequired(raw: unknown, props: Record<string, unknown>): unknown[] {
  const required: unknown[] = [];
  const seen = new Set<string>();
  for (const value of (Array.isArray(raw) ? raw : [])) {
    const name = stringValue(value);
    if (name === "") continue;
    if (!(name in props)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    required.push(name);
  }
  return required;
}

function inferAntigravityClaudeSchemaType(schema: Record<string, unknown>): string {
  if (schema["properties"] !== undefined) return "object";
  if (schema["items"] !== undefined) return "array";
  const enumValues = (schema["enum"] ?? []) as unknown[];
  if (enumValues.length > 0) return inferEnumType(enumValues);
  return "object";
}

function inferEnumType(values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string") return "string";
    if (typeof value === "boolean") return "boolean";
    if (typeof value === "number") return typeof value === "number" && Number.isInteger(value) ? "integer" : "number";
  }
  return "string";
}

function schemaTypeAllowsNull(value: unknown): boolean {
  return Array.isArray(value) && value.some((v) => stringValue(v) === "null");
}

interface SchemaInfo {
  typ: string;
}

export type ToolSchemaMap = Map<string, Map<string, SchemaInfo>>;

function buildToolSchemaMap(raw: unknown): ToolSchemaMap {
  const result = new Map<string, Map<string, SchemaInfo>>();
  for (const tool of (Array.isArray(raw) ? raw : [])) {
    const toolMap = (tool ?? {}) as Record<string, unknown>;
    for (const decl of (toolMap["functionDeclarations"] ?? []) as unknown[]) {
      const declMap = (decl ?? {}) as Record<string, unknown>;
      const originalName = stringValue(declMap["name"]);
      if (originalName === "") continue;
      const schema = (defaultAny(declMap["parametersJsonSchema"], declMap["parameters"]) ?? {}) as Record<string, unknown>;
      const props = (schema["properties"] ?? {}) as Record<string, unknown>;
      if (Object.keys(props).length === 0) continue;
      const paramMap = new Map<string, SchemaInfo>();
      for (const [paramName, rawParam] of Object.entries(props)) {
        const param = (rawParam ?? {}) as Record<string, unknown>;
        paramMap.set(paramName, { typ: defaultEmpty(normalizeSchemaType(param["type"]), "unknown") });
      }
      const sanitizedName = sanitizedToolName(originalName);
      result.set(sanitizedName, paramMap);
      if (sanitizedName !== originalName) result.set(originalName, paramMap);
    }
  }
  return result;
}

function sanitizeToolSchemaKeys(schemas: ToolSchemaMap): void {
  for (const [name, params] of schemas) {
    const sanitized = sanitizedToolName(name);
    if (sanitized !== name) schemas.set(sanitized, params);
  }
}

function sanitizedToolName(name: string): string {
  if (name !== "" && name[0]! >= "0" && name[0]! <= "9") {
    return "t_" + name;
  }
  return name;
}

function normalizeToolCallArgs(args: unknown, toolName: string, schemas: ToolSchemaMap): unknown {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const record = args as Record<string, unknown>;
  const params = schemas.get(toolName);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const expectedType = params?.get(key)?.typ ?? "";
    if (expectedType === "string") {
      result[key] = processEscapeSequencesOnly(value);
      continue;
    }
    if (typeof value === "string" && (expectedType === "array" || expectedType === "object")) {
      try {
        result[key] = JSON.parse(value);
      } catch {
        result[key] = processEscapeSequencesOnly(value);
      }
      continue;
    }
    result[key] = processEscapeSequencesOnly(value);
  }
  return result;
}

function processEscapeSequencesOnly(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if ((!value.includes("\\n") && !value.includes("\\t")) || value.includes('\\"') || value.includes("\\\\")) {
    return value;
  }
  try {
    return JSON.parse('"' + value.split('"').join('\\"') + '"');
  } catch {
    return value;
  }
}

function unwrapGeminiResponse(data: unknown): Record<string, unknown> {
  if (Array.isArray(data)) {
    for (const item of data) {
      const unwrapped = unwrapGeminiResponse(item);
      if (Object.keys(unwrapped).length > 0) return unwrapped;
    }
    return {};
  }
  if (!data || typeof data !== "object") return {};
  const obj = data as Record<string, unknown>;
  const response = obj["response"];
  if (response && typeof response === "object") {
    return response as Record<string, unknown>;
  }
  return obj;
}

export function geminiToOpenAICompletion(response: Record<string, unknown>, model: string, schemas: ToolSchemaMap): Record<string, unknown> {
  let content = "";
  let reasoning = "";
  const toolCalls: unknown[] = [];
  let toolIndex = 0;
  for (const delta of geminiDeltas(response, schemas, { index: toolIndex })) {
    toolIndex = delta._toolIndex as number;
    delete delta._toolIndex;
    content += stringValue(delta["content"]);
    reasoning += stringValue(delta["reasoning_content"]);
    const calls = delta["tool_calls"];
    if (Array.isArray(calls)) toolCalls.push(...calls);
  }
  const message: Record<string, unknown> = { role: "assistant", content: null };
  if (content !== "") message["content"] = content;
  if (reasoning !== "") message["reasoning_content"] = reasoning;
  let finish = "stop";
  if (toolCalls.length > 0) {
    message["tool_calls"] = stripToolCallIndexes(toolCalls);
    finish = "tool_calls";
  } else {
    const [mapped, ok] = geminiFinishReason(response, false);
    if (ok) finish = mapped;
  }
  const usage = geminiUsage(response) ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  return { id: randomID("chatcmpl"), object: "chat.completion", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message, finish_reason: finish }], usage };
}

function geminiDeltas(response: Record<string, unknown>, schemas: ToolSchemaMap, state: { index: number }): Array<Record<string, unknown>> {
  const deltas: Array<Record<string, unknown>> = [];
  const candidates = (response["candidates"] ?? []) as unknown[];
  for (const rawCandidate of candidates) {
    const candidate = (rawCandidate ?? {}) as Record<string, unknown>;
    const content = (candidate["content"] ?? {}) as Record<string, unknown>;
    const parts = (content["parts"] ?? []) as unknown[];
    for (const rawPart of parts) {
      const part = (rawPart ?? {}) as Record<string, unknown>;
      const fn = part["functionCall"];
      if (fn && typeof fn === "object") {
        const fnMap = fn as Record<string, unknown>;
        const name = stringValue(fnMap["name"]);
        let args = normalizeToolCallArgs(fnMap["args"], name, schemas);
        let encodedArgs = JSON.stringify(args);
        if (encodedArgs === "" || encodedArgs === "null") encodedArgs = "{}";
        let id = stringValue(fnMap["id"]);
        if (id === "") id = randomID("call");
        const idx = state.index;
        state.index = idx + 1;
        deltas.push({ tool_calls: [{ index: idx, id, type: "function", function: { name, arguments: encodedArgs } }], _toolIndex: state.index as number });
        continue;
      }
      const text = stringValue(part["text"]);
      if (text === "") continue;
      if (part["thought"] === true) {
        deltas.push({ reasoning_content: text, _toolIndex: state.index as number });
      } else {
        deltas.push({ content: text, _toolIndex: state.index as number });
      }
    }
  }
  return deltas;
}

function stripToolCallIndexes(calls: unknown[]): unknown[] {
  return calls.map((rawCall) => {
    if (!rawCall || typeof rawCall !== "object" || Array.isArray(rawCall)) return rawCall;
    const call = rawCall as Record<string, unknown>;
    const copyCall = { ...call };
    delete copyCall["index"];
    return copyCall;
  });
}

function geminiUsage(response: Record<string, unknown>): Record<string, unknown> | null {
  const rawUsage = response["usageMetadata"];
  if (!rawUsage || typeof rawUsage !== "object") return null;
  const usage = rawUsage as Record<string, unknown>;
  return { prompt_tokens: numberFromAny(usage["promptTokenCount"]), completion_tokens: numberFromAny(usage["candidatesTokenCount"]), total_tokens: numberFromAny(usage["totalTokenCount"]) };
}

function geminiFinishReason(response: Record<string, unknown>, hasToolCalls: boolean): [string, boolean] {
  for (const rawCandidate of (response["candidates"] ?? []) as unknown[]) {
    const candidate = (rawCandidate ?? {}) as Record<string, unknown>;
    const finish = stringValue(candidate["finishReason"]);
    if (finish === "") continue;
    if (hasToolCalls) return ["tool_calls", true];
    switch (finish) {
      case "MAX_TOKENS":
        return ["length", true];
      case "TOOL_CALLS":
        return ["tool_calls", true];
      default:
        return ["stop", true];
    }
  }
  return ["", false];
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

function lastModelSegment(model: string): string {
  const idx = model.lastIndexOf("/");
  return idx >= 0 ? model.slice(idx + 1) : model;
}

function defaultEmpty(value: string, fallback: string): string {
  return value === "" ? fallback : value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function convertImageURLsToBase64Local(client: HttpClient, ctx: RequestContext, messages: unknown[]): Promise<unknown[]> {
  const { convertImageURLsToBase64 } = await import("./images.js");
  return convertImageURLsToBase64(client, ctx, messages);
}

function streamFromStringSafe(text: string): ReadableStream<Uint8Array> {
  const { streamFromString } = awaitImport();
  return streamFromString(text);
}

function awaitImport(): { streamFromString(text: string): ReadableStream<Uint8Array> } {
  // static import at top avoided; use direct helper
  return { streamFromString: (t: string) => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(t)); c.close(); } }) };
}

const geminiToolSchemaSystemInstruction = `<CRITICAL_TOOL_USAGE_INSTRUCTIONS>
You are operating in a CUSTOM ENVIRONMENT where tool definitions COMPLETELY DIFFER from your training data.
VIOLATION OF THESE RULES WILL CAUSE IMMEDIATE SYSTEM FAILURE.

## ABSOLUTE RULES - NO EXCEPTIONS

1. **SCHEMA IS LAW**: The JSON schema in each tool definition is the ONLY source of truth.
2. **PARAMETER NAMES ARE EXACT**: Use ONLY the parameter names from the schema.
3. **ARRAY PARAMETERS**: When a parameter has "type": "array", check the 'items' field.
4. **NESTED OBJECTS**: When items.type is "object", include exact required nested fields.
5. **STRICT PARAMETERS HINT**: Tool descriptions contain "STRICT PARAMETERS: ...".
6. **BEFORE EVERY TOOL CALL**: Read tool schema and verify exact required params.
</CRITICAL_TOOL_USAGE_INSTRUCTIONS>

## GEMINI 3 RESPONSE RULES
- Default to a direct, concise answer; add detail only when asked or required for correctness.
- For multi-part tasks, use a short numbered list or labeled sections.
- For long provided context, answer only from that context and avoid assumptions.
- For multimodal inputs, explicitly reference each modality used and synthesize across them; do not invent details from absent modalities.
- For complex tasks, outline a short plan and verify constraints before acting.
`;
