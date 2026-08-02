import { createHmac } from "node:crypto";
import type Redis from "ioredis";
import type { ProxyDB, ProviderAccount } from "./db/index.js";
import { schema } from "./db/index.js";
import { eq } from "drizzle-orm";
import type { Registry } from "./registry/index.js";
import { AuthService } from "./auth/service.js";
import { AuthModelService, parseModelParam } from "./auth/models.js";
import type { AuthResult, ModelValidationResult } from "./auth/types.js";
import type { Provider, ProviderAccountLike, RefreshedCredentials, UpstreamResponse, HttpClient } from "./providers/types.js";
import { nodeHttpClient } from "./providers/http.js";
import { ProviderRegistry, refreshBufferFor } from "./providers/providers.js";
import { Affinity } from "./session/index.js";
import { KiroProvider } from "./providers/kiro.js";
import { QoderProvider } from "./providers/qoder.js";
import { CodexProvider } from "./providers/codex.js";
import { CommandCodeProvider } from "./providers/command_code.js";
import { MimoCodeProvider } from "./providers/mimo_code.js";
import { AntigravityProvider } from "./providers/google_code_assist.js";
import { LoadBalancer } from "./core/load-balancer.js";
import { isSyntheticProviderAccountID } from "./core/load-balancer-helpers.js";
import { executeAccountRotation, sessionID } from "./core/attempts.js";
import { passthroughStream, passthroughNonStream } from "./core/stream.js";
import { anthropicStream, anthropicNonStream } from "./core/anthropic/stream.js";
import { logUsage, recordLatency } from "./core/usage.js";
import { reserveRoamingPoint, refundRoamingPoint, creditSharingPoint, type PointReservation } from "./core/points.js";
import { checkAndIncrementAPIKeyRateLimit } from "./core/ratelimit.js";
import { upsertErrorHistory } from "./core/error-history.js";
import { TokenRefresher } from "./core/token-refresher.js";
import { retryMetadata, ptrIfNotEmpty } from "./core/errors.js";
import type { EndpointAdapter, ParsedEndpointRequest, ResponseContext, RouteError } from "./core/types.js";
import { chatCompletionsConfig } from "./routes/chat.js";
import { messagesConfig } from "./routes/messages.js";
import { responsesConfig } from "./routes/responses.js";
import { decrypt } from "./crypto/index.js";
import { streamFromAsyncIterable } from "./providers/http.js";
import { loadQuotaAccount, type QuotaFetcherDeps } from "./core/quota/quota-fetchers.js";
import { fetchCommandCodeQuota } from "./core/quota/quota-commandcode.js";
import type { AccountQuotaInfo, QuotaRequest } from "./core/quota/quota.js";

const playgroundUserIDHeader = "X-Opendum-Playground-User-Id";
const playgroundTimestampHeader = "X-Opendum-Playground-Timestamp";
const playgroundSignatureHeader = "X-Opendum-Playground-Signature";
const playgroundAuthWindow = 2 * 60 * 1000;

export class ProxyService {
  db: ProxyDB | null;
  redis: Redis | null;
  auth: AuthService;
  authModels: AuthModelService;
  registry: Registry;
  providerRegistry: ProviderRegistry;
  affinity: Affinity;
  secret: string;
  client: HttpClient;
  loadBalancer: LoadBalancer;
  tokenRefresher: TokenRefresher;

  constructor(db: ProxyDB | null, redisClient: Redis | null, authSvc: AuthService, authModels: AuthModelService, registry: Registry, secret: string) {
    this.db = db;
    this.redis = redisClient;
    this.auth = authSvc;
    this.authModels = authModels;
    this.registry = registry;
    this.secret = secret;
    this.client = nodeHttpClient();
    this.affinity = new Affinity(redisClient, ["zenmux", "codex", "siliconflow", "openrouter"]);
    this.providerRegistry = new ProviderRegistry(registry);
    this.providerRegistry.register("kiro", new KiroProvider(registry));
    this.providerRegistry.register("qoder", new QoderProvider(registry));
    this.providerRegistry.register("codex", new CodexProvider(registry, redisClient, db));
    this.providerRegistry.register("command_code", new CommandCodeProvider(registry));
    this.providerRegistry.register("mimo_code", new MimoCodeProvider(registry));
    this.providerRegistry.register("antigravity", new AntigravityProvider(registry, db, redisClient));
    this.loadBalancer = new LoadBalancer({
      db,
      registry,
      affinity: this.affinity,
      upsertErrorHistory: (accountID, userID, model, statusCode, message, createdAt) => upsertErrorHistory(redisClient, accountID, userID, model, statusCode, message, createdAt),
    });
    this.tokenRefresher = new TokenRefresher({
      db,
      redis: redisClient,
      registry,
      secret,
      client: this.client,
      getProvider: (name) => this.providerRegistry.get(name),
      refreshableProviderNames: () => this.providerRegistry.refreshableProviderNames(),
    });
  }

  // ---- route configs ----

  chatCompletionsConfig(): EndpointAdapter {
    return chatCompletionsConfig({
      handleStream: (ctx) => this.handleStreamPassthrough(ctx, "openai"),
      handleNonStream: (ctx) => this.handleNonStreamPassthrough(ctx, "openai"),
    });
  }

  messagesAdapter(): EndpointAdapter {
    return messagesConfig({
      handleStream: (ctx) => anthropicStream(ctx, this.streamCallbacks(ctx)),
      handleNonStream: (ctx) => anthropicNonStream(ctx, this.streamCallbacks(ctx)),
    });
  }

  responsesAdapter(): EndpointAdapter {
    return responsesConfig({
      handleStream: (ctx) => this.handleStreamPassthrough(ctx, "openai"),
      handleNonStream: (ctx) => this.handleNonStreamPassthrough(ctx, "openai"),
    });
  }

  private streamCallbacks(ctx: ResponseContext) {
    return {
      recordSuccess: (params: { inputTokens: number; outputTokens: number; durationMS: number }) => {
        this.recordSuccessfulRequest(ctx, params.inputTokens, params.outputTokens, params.durationMS, ctx.response.headers);
      },
    };
  }

  private async handleStreamPassthrough(ctx: ResponseContext, _format: "openai"): Promise<void> {
    return passthroughStream(ctx, this.streamCallbacks(ctx));
  }

  private async handleNonStreamPassthrough(ctx: ResponseContext, _format: "openai"): Promise<void> {
    return passthroughNonStream(ctx, this.streamCallbacks(ctx));
  }

  private recordSuccessfulRequest(ctx: ResponseContext, inputTokens: number, outputTokens: number, durationMS: number, _headers: Record<string, string>): void {
    void this.loadBalancer.markAccountSuccess(ctx.accountId, ctx.model);
    if (ctx.upstreamFirstResponseMS > ctx.requestStartMS) {
      void recordLatency(this.redis, ctx.provider, ctx.model, true, ctx.upstreamFirstResponseMS - ctx.requestStartMS);
    }
    void logUsage(this.db, this.redis, (userId) => void this.auth.bumpAnalyticsCacheVersion(userId), {
      userId: ctx.userId,
      providerAccountId: ctx.accountId,
      proxyApiKeyId: ctx.apiKeyId,
      model: ctx.model,
      inputTokens,
      outputTokens,
      statusCode: 200,
      durationMS,
      provider: ctx.provider,
    });
  }

  // ---- main handle flow ----

  async handle(request: Request, cfg: EndpointAdapter): Promise<{ status: number; headers: Record<string, string>; body: ReadableStream<Uint8Array> | string | null }> {
    const startMS = Date.now();

    const [authResult, playgroundAuth, authErr] = await this.authenticateRequest(request);
    if (authErr) {
      return this.routeErrorResponse(cfg, 500, "Internal server error", "api_error", null, null, null, null, "");
    }
    if (!authResult.valid) {
      return this.routeErrorResponse(cfg, 401, authResult.error, "authentication_error", null, null, null, null, "");
    }

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return this.routeErrorResponse(cfg, 400, "Invalid JSON in request body", "invalid_request_error", null, null, null, null, "");
    }
    if (!body || typeof body !== "object") {
      return this.routeErrorResponse(cfg, 400, "Invalid JSON in request body", "invalid_request_error", null, null, null, null, "");
    }

    const [parsed0, routeErr] = cfg.parse(body);
    if (routeErr) {
      return this.routeErrorResponse(cfg, routeErr.status, routeErr.message, routeErr.type, routeErr.param, routeErr.code, routeErr.retryAfter, routeErr.retryAfterMS, routeErr.accountID);
    }
    const parsed = this.applyModelAccountSelector(parsed0);

    let validation: ModelValidationResult;
    let validationErr: Error | null = null;
    try {
      validation = await this.authModels.validateModelForUser(authResult.userId, parsed.modelParam, {
        mode: authResult.modelAccessMode,
        models: authResult.modelAccessList,
        roamingEnabled: authResult.roamingEnabled,
      });
    } catch (error) {
      validationErr = error as Error;
      validation = { valid: false, provider: null, model: "", error: "", param: "", code: "" };
    }
    if (validationErr) {
      return this.routeErrorResponse(cfg, 500, "Internal server error", "api_error", null, null, null, null, "");
    }
    if (!validation.valid) {
      return this.routeErrorResponse(cfg, 400, validation.error, "invalid_request_error", ptrIfNotEmpty(validation.param), ptrIfNotEmpty(validation.code), null, null, "");
    }

    if (authResult.apiKeyId !== "" && authResult.rateLimitRules.length > 0) {
      const rl = await checkAndIncrementAPIKeyRateLimit(this.redis, authResult.apiKeyId, validation.model, authResult.rateLimitRules, this.registry.modelFamily(validation.model));
      if (!rl.allowed) {
        const headers: Record<string, string> = {};
        if (rl.retryAfterSeconds > 0) headers["retry-after"] = String(rl.retryAfterSeconds);
        const message = `Rate limit exceeded for ${validation.model}: ${rl.current}/${rl.limit} requests per ${rl.exceededWindow}. Retry after ${rl.retryAfterSeconds}s.`;
        const [retryAfter, retryAfterMS] = retryMetadata(rl.retryAfterSeconds * 1000);
        const [respStatus, respHeaders, respBody] = this.routeErrorResponseParts(cfg, cfg.rateLimitStatusCode, message, "rate_limit_error", null, null, retryAfter, retryAfterMS, "");
        return { status: respStatus, headers: { ...headers, ...respHeaders }, body: respBody };
      }
    }

    const [forced, forceErr] = await this.loadBalancer.validateForcedAccount(authResult.userId, validation, parsed.forcedAccountID, { mode: authResult.accountAccessMode, accounts: authResult.accountAccessList }, playgroundAuth);
    if (forceErr) {
      return this.routeErrorResponse(cfg, forceErr.status, forceErr.message, forceErr.type, forceErr.param, forceErr.code, forceErr.retryAfter, forceErr.retryAfterMS, forceErr.accountID);
    }

    const sessID = sessionID(request);
    const rotation = await executeAccountRotation(this.rotationRunner(), cfg, parsed, authResult, validation, forced, startMS, sessID);
    if (rotation.error) {
      const headers: Record<string, string> = {};
      if (rotation.error.accountID !== "") headers["x-provider-account-id"] = rotation.error.accountID;
      const [status, respHeaders, respBody] = this.routeErrorResponseParts(cfg, rotation.error.status, rotation.error.message, rotation.error.type, rotation.error.param, rotation.error.code, rotation.error.retryAfter, rotation.error.retryAfterMS, rotation.error.accountID);
      return { status, headers: { ...headers, ...respHeaders }, body: respBody };
    }
    if (!rotation.account || !rotation.response) {
      return this.routeErrorResponse(cfg, 503, "No available accounts for this request.", "api_error", null, null, null, null, "");
    }

    const responseCtx: ResponseContext = {
      response: rotation.response,
      accountId: rotation.account.id,
      provider: rotation.account.provider,
      writer: null as never,
      request,
      requestStartMS: rotation.requestStartMS,
      upstreamFirstResponseMS: rotation.upstreamFirstResponseMS,
      startMS,
      userId: authResult.userId,
      apiKeyId: authResult.apiKeyId,
      model: validation.model,
    };

    if (parsed.stream) {
      const writer = new ControllerStreamWriter();
      responseCtx.writer = writer;
      let handlerErr: Error | null = null;
      const svc: ProxyService = this;
      const stream = streamFromAsyncIterable((async function* () {
        try {
          await cfg.handleStream(responseCtx);
        } catch (error) {
          handlerErr = error as Error;
        }
        if (handlerErr) {
          if (rotation.roaming) await refundRoamingPoint(svc.db, rotation.roaming);
          await svc.recordResponseHandlerFailure(rotation.account!, validation.model, authResult.userId, authResult.apiKeyId, handlerErr, startMS);
        } else {
          if (rotation.roaming) void creditSharingPoint(svc.db, rotation.account!.userId, rotation.roaming.debitID, rotation.roaming.amount);
          void svc.loadBalancer.markAccountsRecoveredByRotation(rotation.rotationFailures);
        }
        writer.close();
        yield* writer.chunks();
      })());
      const headers: Record<string, string> = {
        "content-type": writer.contentType,
        "cache-control": writer.cacheControl,
        "connection": "keep-alive",
        "x-accel-buffering": "no",
        "x-provider-account-id": rotation.account.id,
      };
      return { status: 200, headers, body: stream };
    }

    const writer = new ControllerStreamWriter();
    responseCtx.writer = writer;
    let handlerErr: Error | null = null;
    try {
      await cfg.handleNonStream(responseCtx);
    } catch (error) {
      handlerErr = error as Error;
    }
    if (handlerErr) {
      if (rotation.roaming) await refundRoamingPoint(this.db, rotation.roaming);
      await this.recordResponseHandlerFailure(rotation.account, validation.model, authResult.userId, authResult.apiKeyId, handlerErr, startMS);
      return this.routeErrorResponse(cfg, 500, "Internal server error", "api_error", null, null, null, null, "");
    }
    if (rotation.roaming) void creditSharingPoint(this.db, rotation.account.userId, rotation.roaming.debitID, rotation.roaming.amount);
    void this.loadBalancer.markAccountsRecoveredByRotation(rotation.rotationFailures);
    writer.close();
    const headers: Record<string, string> = { ...writer.headers, "x-provider-account-id": rotation.account.id };
    return { status: writer.status, headers, body: await writer.text() };
  }

  private rotationRunner() {
    const s: ProxyService = this;
    return {
      getNextAvailableAccount: (userID: string, model: string, provider: string | null, exclude: string[], excludeProviders: string[], accountAccess: { mode: string; accounts: string[] }, sessionID: string) =>
        s.loadBalancer.getNextAvailableAccount(userID, model, provider, exclude, excludeProviders, accountAccess, sessionID),
      getNextSharedAccount: (userID: string, model: string, provider: string | null, exclude: string[], excludeProviders: string[]) =>
        s.loadBalancer.getNextSharedAccount(userID, model, provider, exclude, excludeProviders),
      reserveRoamingPoint: (userID: string) => reserveRoamingPoint(s.db, userID),
      refundRoamingPoint: (reservation: PointReservation | null) => refundRoamingPoint(s.db, reservation),
      bumpAccountRequestCount: (accountID: string, usedAt: Date) => s.loadBalancer.bumpAccountRequestCount(accountID, usedAt),
      makeProviderRequest: (account: ProviderAccount, payload: Record<string, unknown>, stream: boolean, ctx: Record<string, unknown>) => s.makeProviderRequest(account, payload, stream, ctx),
      markAccountFailed: (accountID: string, model: string, status: number, message: string) => s.loadBalancer.markAccountFailed(accountID, model, status, message),
      markAccountUsageLimited: (accountID: string, model: string, disabledUntil: Date, failedAt: Date) => s.loadBalancer.markAccountUsageLimited(accountID, model, disabledUntil, failedAt),
      logUsage: (params: { userId: string; providerAccountId: string; proxyApiKeyId: string; model: string; statusCode: number; durationMS: number; provider: string; inputTokens?: number; outputTokens?: number }) =>
        logUsage(s.db, s.redis, (userId) => void s.auth.bumpAnalyticsCacheVersion(userId), { inputTokens: 0, outputTokens: 0, ...params }),
      isVisionModel: (model: string) => s.registry.isVisionModel(model),
      isToolCallModel: (model: string) => s.registry.isToolCallModel(model),
    };
  }

  async recordResponseHandlerFailure(account: ProviderAccount, model: string, userID: string, apiKeyID: string, err: Error, startMS: number): Promise<void> {
    if (!account || !err) return;
    const message = err.message;
    await this.loadBalancer.markAccountFailed(account.id, model, 500, message);
    await logUsage(this.db, this.redis, (userId) => void this.auth.bumpAnalyticsCacheVersion(userId), {
      userId: userID,
      providerAccountId: account.id,
      proxyApiKeyId: apiKeyID,
      model,
      statusCode: 500,
      durationMS: Date.now() - startMS,
      provider: account.provider,
      inputTokens: 0,
      outputTokens: 0,
    });
  }

  // ---- auth ----

  async authenticateRequest(request: Request): Promise<[AuthResult, boolean, Error | null]> {
    const playground = this.validatePlaygroundAuth(request);
    if (playground) {
      return [playground, true, null];
    }
    let authHeader = request.headers.get("authorization") ?? "";
    if (authHeader === "") {
      authHeader = request.headers.get("x-api-key") ?? "";
    }
    try {
      const result = await this.auth.validateAPIKey(authHeader);
      return [result, false, null];
    } catch (error) {
      return [{ valid: false, userId: "", apiKeyId: "", modelAccessMode: "all", modelAccessList: [], accountAccessMode: "all", accountAccessList: [], roamingEnabled: false, rateLimitRules: [], error: "Invalid API key" }, false, error as Error];
    }
  }

  validatePlaygroundAuth(request: Request): AuthResult | null {
    const userID = request.headers.get(playgroundUserIDHeader)?.trim() ?? "";
    const timestampValue = request.headers.get(playgroundTimestampHeader)?.trim() ?? "";
    const signature = request.headers.get(playgroundSignatureHeader)?.trim() ?? "";
    if (userID === "" && timestampValue === "" && signature === "") return null;
    if (userID === "" || timestampValue === "" || signature === "" || this.secret.trim() === "") {
      return { valid: false, userId: "", apiKeyId: "", modelAccessMode: "all", modelAccessList: [], accountAccessMode: "all", accountAccessList: [], roamingEnabled: false, rateLimitRules: [], error: "Invalid playground session" };
    }
    const timestamp = Number.parseInt(timestampValue, 10);
    if (Number.isNaN(timestamp)) {
      return { valid: false, userId: "", apiKeyId: "", modelAccessMode: "all", modelAccessList: [], accountAccessMode: "all", accountAccessList: [], roamingEnabled: false, rateLimitRules: [], error: "Invalid playground session" };
    }
    const requestTime = new Date(timestamp * 1000);
    const now = Date.now();
    if (now - requestTime.getTime() > playgroundAuthWindow || requestTime.getTime() - now > playgroundAuthWindow) {
      return { valid: false, userId: "", apiKeyId: "", modelAccessMode: "all", modelAccessList: [], accountAccessMode: "all", accountAccessList: [], roamingEnabled: false, rateLimitRules: [], error: "Invalid playground session" };
    }

    const expected = playgroundSignature(this.secret, userID, timestampValue, request.method, new URL(request.url).pathname);
    const provided = signature;
    const providedBuf = Buffer.from(provided, "hex");
    const expectedBuf = Buffer.from(expected, "hex");
    if (providedBuf.length !== expectedBuf.length || !timingSafeEqual(providedBuf, expectedBuf)) {
      return { valid: false, userId: "", apiKeyId: "", modelAccessMode: "all", modelAccessList: [], accountAccessMode: "all", accountAccessList: [], roamingEnabled: false, rateLimitRules: [], error: "Invalid playground session" };
    }

    return { valid: true, userId: userID, apiKeyId: "", modelAccessMode: "all", modelAccessList: [], accountAccessMode: "all", accountAccessList: [], roamingEnabled: false, rateLimitRules: [], error: "" };
  }

  // ---- model account selector ----

  applyModelAccountSelector(parsed: ParsedEndpointRequest): ParsedEndpointRequest {
    const [accountID, model, ok] = this.modelAccountSelector(parsed.modelParam);
    if (!ok) return parsed;
    parsed.modelParam = model;
    parsed.forcedAccountID = accountID;
    return parsed;
  }

  modelAccountSelector(modelParam: string): [string, string, boolean] {
    const index = modelParam.indexOf("/");
    if (index < 0) return ["", "", false];
    const prefix = modelParam.slice(0, index).trim();
    const model = modelParam.slice(index + 1).trim();
    if (prefix === "" || model === "" || this.isKnownModelProviderPrefix(prefix)) {
      return ["", "", false];
    }
    return [prefix, model, true];
  }

  isKnownModelProviderPrefix(prefix: string): boolean {
    const provider = prefix.trim().toLowerCase();
    if (provider === "") return false;
    if (this.providerRegistry.get(provider)) return true;
    return this.registry.modelsForProvider(provider).length > 0;
  }

  // ---- provider requests ----

  async makeProviderRequest(account: ProviderAccount, payload: Record<string, unknown>, stream: boolean, ctx: Record<string, unknown>): Promise<UpstreamResponse> {
    const providerImpl = this.providerRegistry.get(account.provider);
    if (!providerImpl) {
      throw new Error(`provider ${account.provider} is not implemented in proxy yet`);
    }
    const p = providerImpl as unknown as { authless?: () => boolean };
    const isAuthless = typeof p.authless === "function" && p.authless();
    if (isAuthless || isSyntheticProviderAccountID(account.id)) {
      return providerImpl.makeRequest(this.client, ctx as never, "", account as unknown as ProviderAccountLike, payload, stream);
    }
    const [credentials, requestAccount, err] = await this.tokenRefresher.credentialsForAccount(account as unknown as ProviderAccountLike, providerImpl);
    if (err) throw err;
    return providerImpl.makeRequest(this.client, ctx as never, credentials, requestAccount, payload, stream);
  }

  // ---- quota ----

  async fetchQuota(input: QuotaRequest): Promise<AccountQuotaInfo> {
    const account = await loadQuotaAccount(this.db, input);
    if (!account) throw new Error("Account not found");
    return this.fetchAccountQuota(account, input.forceRefresh === true);
  }

  private async fetchAccountQuota(account: ProviderAccount, forceRefresh: boolean): Promise<AccountQuotaInfo> {
    const deps: QuotaFetcherDeps = {
      client: this.client,
      ctx: {},
      redis: this.redis,
      db: this.db,
      secret: this.secret,
      registry: this.registry,
      getProviderCredentials: async (acc) => {
        const [credentials, requestAccount, err] = await this.tokenRefresher.credentialsForAccount(acc as unknown as ProviderAccountLike, this.providerRegistry.get(acc.provider) as Provider);
        return [credentials, requestAccount as unknown as ProviderAccount, err];
      },
      decryptSecret: (ciphertext) => decrypt(this.secret, ciphertext),
    };

    if (account.provider === "openrouter") {
      return (await import("./core/quota/quota-fetchers.js")).fetchOpenRouterQuota(deps, account, forceRefresh);
    }
    if (account.provider === "siliconflow") {
      return (await import("./core/quota/quota-fetchers.js")).fetchSiliconFlowQuota(deps, account, forceRefresh);
    }
    if (account.provider === "zenmux") {
      return (await import("./core/quota/quota-fetchers.js")).fetchZenmuxQuota(deps, account, forceRefresh);
    }
    const providerImpl = this.providerRegistry.get(account.provider);
    if (!providerImpl) {
      throw new Error(`provider ${account.provider} is not supported for quota`);
    }
    let credentials: string;
    let requestAccount: ProviderAccount;
    try {
      const [cred, reqAccount, err] = await this.tokenRefresher.credentialsForAccount(account as unknown as ProviderAccountLike, providerImpl);
      if (err) throw err;
      credentials = cred;
      requestAccount = reqAccount as unknown as ProviderAccount;
    } catch {
      return { status: "expired", error: "Token expired - please re-authenticate", groups: [] };
    }

    switch (account.provider) {
      case "antigravity":
        return (await import("./core/quota/quota-fetchers.js")).fetchAntigravityQuota(deps, requestAccount, credentials, forceRefresh);
      case "codex":
        return (await import("./core/quota/quota-fetchers.js")).fetchCodexQuota(deps, requestAccount, credentials, forceRefresh);
      case "kiro":
        return (await import("./core/quota/quota-fetchers.js")).fetchKiroQuota(deps, requestAccount, credentials, forceRefresh);
      case "command_code":
        return fetchCommandCodeQuota(deps, requestAccount, credentials, forceRefresh);
      default:
        throw new Error(`provider ${account.provider} is not supported for quota`);
    }
  }

  // ---- error responses ----

  routeErrorResponse(cfg: EndpointAdapter, status: number, message: string, typ: string, param: string | null, code: string | null, retryAfter: string | null, retryAfterMS: number | null, accountID: string): { status: number; headers: Record<string, string>; body: string } {
    const [s, h, b] = this.routeErrorResponseParts(cfg, status, message, typ, param, code, retryAfter, retryAfterMS, accountID);
    return { status: s, headers: h, body: b };
  }

  private routeErrorResponseParts(cfg: EndpointAdapter, status: number, message: string, typ: string, param: string | null, code: string | null, retryAfter: string | null, retryAfterMS: number | null, _accountID: string): [number, Record<string, string>, string] {
    if (typ === "") typ = "invalid_request_error";
    const headers: Record<string, string> = { "content-type": "application/json" };
    let body: string;
    if (cfg.format === "anthropic") {
      const errorBody: Record<string, unknown> = { type: typ, message };
      if (retryAfter !== null) errorBody["retry_after"] = retryAfter;
      if (retryAfterMS !== null) errorBody["retry_after_ms"] = retryAfterMS;
      body = JSON.stringify({ type: "error", error: errorBody });
    } else {
      const info: Record<string, unknown> = { message, type: typ };
      if (param !== null) info["param"] = param;
      if (code !== null) info["code"] = code;
      if (retryAfter !== null) info["retry_after"] = retryAfter;
      if (retryAfterMS !== null) info["retry_after_ms"] = retryAfterMS;
      body = JSON.stringify({ error: info });
    }
    return [status, headers, body];
  }
}

export function playgroundSignature(secret: string, userID: string, timestamp: string, method: string, path: string): string {
  const mac = createHmac("sha256", secret);
  mac.update(userID + "\n" + timestamp + "\n" + method + "\n" + path);
  return mac.digest("hex");
}

function timingSafeEqual(a: Buffer, b: Buffer): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}

/** Push-based live stream writer: writes are drained by the response generator. */
export class ControllerStreamWriter {
  status = 200;
  contentType = "application/json";
  cacheControl = "no-cache";
  headers: Record<string, string> = {};
  private queue: Array<Uint8Array | null> = [];
  private waiters: Array<(value: Uint8Array | null) => void> = [];
  private closed = false;

  header(name: string, value: string): void {
    const lower = name.toLowerCase();
    if (lower === "content-type") this.contentType = value;
    else if (lower === "cache-control") this.cacheControl = value;
    else this.headers[name] = value;
  }

  async write(chunk: Uint8Array | string): Promise<void> {
    if (this.closed) return;
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(bytes);
    } else {
      this.queue.push(bytes);
    }
  }

  flush(): void {
    // no-op
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const waiter = this.waiters.shift();
    if (waiter) waiter(null);
    else this.queue.push(null);
  }

  async* chunks(): AsyncGenerator<string> {
    for (;;) {
      const item = this.queue.length > 0 ? this.queue.shift()! : await new Promise<Uint8Array | null>((resolve) => this.waiters.push(resolve));
      if (item === null) return;
      yield new TextDecoder().decode(item);
    }
  }

  async text(): Promise<string> {
    let out = "";
    for await (const chunk of this.chunks()) {
      out += chunk;
    }
    return out;
  }
}
