import type { AuthResult, AuthService, ModelValidationResult } from "@opendum/auth";
import { playgroundSignature, signaturesMatch } from "@opendum/crypto";
import type { Database } from "@opendum/database";
import type { Registry } from "@opendum/models/runtime";
import type { Provider, ProviderAccount, ProviderRegistry } from "@opendum/providers";
import { SessionAffinity, type OpendumRedis } from "@opendum/redis";

import { prefixWithProvider, retryMetadata } from "./errors.js";
import { cloneMap, numberAsInt } from "./helpers.js";
import {
  adjustRoamingPoints,
  creditSharingPoint,
  refundRoamingPoint,
  roamingPoints,
  settleRoamingPoint,
  type PointReservation,
} from "./points.js";
import { ProviderPerformance } from "./provider-performance.js";
import { checkAndIncrementAPIKeyRateLimit } from "./ratelimit.js";
import {
  customProviderForAccount as customProviderForAccountImpl,
  quotaCredentials as quotaCredentialsImpl,
  startTokenRefresher as startTokenRefresherImpl,
} from "./service-credentials.js";
import type { ProxyDeps } from "./service-deps.js";
import {
  markAccountsRecoveredByRotation,
  recordResponseHandlerFailure,
  recordSuccessfulRequest as recordSuccessfulRequestImpl,
  storeHypercreditsUsage as storeHypercreditsUsageImpl,
} from "./service-health.js";
import {
  executeWithAccountRotation,
  modelAccountSelector,
  validateForcedAccount,
} from "./service-routing.js";
import type {
  AccountRotationFailure,
  AttemptResult,
  EndpointAdapter,
  ParsedEndpointRequest,
  ResponseContext,
  RouteError,
  StreamCompletion,
  StreamRecorder,
  UsageCounts,
} from "./types.js";

export type ProxyServiceOptions = {
  database: Database;
  redis: OpendumRedis;
  models: Registry;
  auth: AuthService;
  providers: ProviderRegistry;
  betterAuthSecret: string;
  requestTimeoutMs: number;
};

type RoamingCompletionContext = {
  account: ProviderAccount;
  authResult: AuthResult;
  validation: ModelValidationResult;
  roaming: PointReservation | null;
  rotationFailures: AccountRotationFailure[];
  usage: UsageCounts;
  startMs: number;
};

export class ProxyService implements StreamRecorder {
  private readonly deps: ProxyDeps;

  constructor(options: ProxyServiceOptions) {
    this.deps = {
      database: options.database,
      redis: options.redis,
      models: options.models,
      auth: options.auth,
      providers: options.providers,
      secret: options.betterAuthSecret,
      requestTimeoutMs: options.requestTimeoutMs,
      affinity: new SessionAffinity(options.redis, options.providers.names()),
      performance: new ProviderPerformance(options.redis),
    };
  }

  async handle(
    cfg: EndpointAdapter,
    body: Record<string, unknown>,
    authHeader: string,
    sessionId: string,
    request?: Request
  ): Promise<Response> {
    const startMs = Date.now();
    let authResult: AuthResult;
    const playground = this.validatePlaygroundAuth(request);
    if (playground.handled) {
      authResult = playground.result;
    } else {
      authResult = await this.deps.auth.validateAPIKey(authHeader);
    }
    if (!authResult.valid) {
      return this.routeError(cfg, { status: 401, message: authResult.error, type: "authentication_error" });
    }

    const parsed = cfg.parse(body);
    if ("status" in parsed && typeof parsed.status === "number") {
      const routeError = parsed as RouteError;
      return this.routeError(cfg, routeError);
    }
    const parsedRequest = parsed as ParsedEndpointRequest;
    const selector = await modelAccountSelector(this.deps, parsedRequest.modelParam, authResult.userId);
    if (selector) {
      parsedRequest.forcedAccountId = selector.accountId;
      parsedRequest.modelParam = selector.model;
    }

    const validation = await this.deps.auth.validateModelForUser(authResult.userId, parsedRequest.modelParam, {
      mode: authResult.modelAccessMode,
      models: authResult.modelAccessList,
      roamingEnabled: authResult.roamingEnabled,
    });
    if (!validation.valid) {
      return this.routeError(cfg, {
        status: 400,
        message: validation.error,
        type: "invalid_request_error",
        param: validation.param || null,
        code: validation.code || null,
      });
    }

    if (authResult.apiKeyId && authResult.rateLimitRules.length > 0) {
      const rl = await checkAndIncrementAPIKeyRateLimit(
        this.deps.redis,
        this.deps.models,
        authResult.apiKeyId,
        validation.model,
        validation.alias,
        authResult.rateLimitRules
      );
      if (!rl.allowed) {
        const retry = retryMetadata(rl.retryAfterSeconds * 1000);
        return this.routeError(cfg, {
          status: cfg.rateLimitStatusCode,
          message: `Rate limit exceeded for ${validation.model}: ${rl.current}/${rl.limit} requests per ${rl.exceededWindow}. Retry after ${rl.retryAfterSeconds}s.`,
          type: "rate_limit_error",
          retryAfter: retry.retryAfter,
          retryAfterMs: retry.retryAfterMs,
        });
      }
    }

    const forced = await validateForcedAccount(
      this.deps,
      authResult.userId,
      validation,
      parsedRequest.forcedAccountId,
      { mode: authResult.accountAccessMode, accounts: authResult.accountAccessList },
      playground.handled
    );
    if (forced && "status" in forced && typeof (forced as RouteError).status === "number") {
      return this.routeError(cfg, forced as RouteError);
    }

    const attempt = await executeWithAccountRotation(
      this.deps,
      cfg,
      parsedRequest,
      authResult,
      validation,
      forced as ProviderAccount | null,
      startMs,
      sessionId
    );
    if ("status" in attempt && typeof attempt.status === "number") {
      return this.routeError(cfg, attempt as RouteError);
    }

    const { account, response, requestStartMs, upstreamFirstResponseMs, rotationFailures, roaming } =
      attempt as AttemptResult;

    const responseCtx: ResponseContext = {
      response,
      accountId: account.id,
      provider: account.provider,
      requestStartMs,
      upstreamFirstResponseMs,
      startMs,
      userId: authResult.userId,
      apiKeyId: authResult.apiKeyId,
      model: validation.model,
      usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 },
    };

    if (parsedRequest.stream) {
      responseCtx.onStreamComplete = (reason) => {
        this.handleStreamCompletion(reason, {
          account,
          authResult,
          validation,
          roaming,
          rotationFailures,
          usage: responseCtx.usage,
          startMs,
        });
      };
      const result = await cfg.handleStream(responseCtx, this);
      if (!responseCtx.streamHandled) {
        if (roaming) {
          await this.settleRoamingPointAsync(account.userId, roaming, validation.model, responseCtx.usage);
        }
        void this.markAccountsRecoveredByRotationDeferred(rotationFailures);
      }
      return result;
    }
    let result: Response;
    try {
      result = await cfg.handleNonStream(responseCtx, this);
    } catch (error) {
      return this.handleNonStreamFailure(cfg, error, {
        account,
        authResult,
        validation,
        roaming,
        rotationFailures,
        usage: responseCtx.usage,
        startMs,
      });
    }
    if (roaming) await this.settleRoamingPointAsync(account.userId, roaming, validation.model, responseCtx.usage);
    void this.markAccountsRecoveredByRotationDeferred(rotationFailures);
    return result;
  }

  private handleStreamCompletion(reason: StreamCompletion, context: RoamingCompletionContext): void {
    const { account, authResult, validation, roaming, rotationFailures, usage, startMs } = context;
    if (roaming) {
      if (reason === "success") {
        void this.settleRoamingPointAsync(account.userId, roaming, validation.model, usage);
      } else {
        void this.refundRoamingPointAsync(roaming);
      }
    }
    if (reason === "error") {
      void recordResponseHandlerFailure(
        this.deps,
        account,
        authResult,
        validation,
        500,
        "upstream stream failed",
        startMs
      );
    }
    if (reason !== "cancel") void this.markAccountsRecoveredByRotationDeferred(rotationFailures);
  }

  private async handleNonStreamFailure(
    cfg: EndpointAdapter,
    error: unknown,
    context: RoamingCompletionContext
  ): Promise<Response> {
    const { account, authResult, validation, roaming, rotationFailures, startMs } = context;
    const message = error instanceof Error ? error.message : String(error);
    if (roaming) await this.refundRoamingPointAsync(roaming);
    await recordResponseHandlerFailure(this.deps, account, authResult, validation, 500, message, startMs);
    void this.markAccountsRecoveredByRotationDeferred(rotationFailures);
    return this.routeError(cfg, {
      status: 500,
      message: prefixWithProvider(account.provider, message),
      type: "api_error",
      accountId: account.id,
    });
  }

  private async refundRoamingPointAsync(reservation: PointReservation): Promise<void> {
    try {
      await refundRoamingPoint(this.deps.database, reservation);
    } catch {
      return;
    }
  }

  private async settleRoamingPointAsync(
    ownerUserId: string,
    roaming: PointReservation,
    model: string,
    usage: UsageCounts
  ): Promise<void> {
    try {
      await settleRoamingPoint(this.deps.database, this.deps.models, ownerUserId, roaming, model, usage);
    } catch {
      return;
    }
  }

  private async markAccountsRecoveredByRotationDeferred(failures: AccountRotationFailure[]): Promise<void> {
    try {
      await markAccountsRecoveredByRotation(this.deps, failures);
    } catch {
      return;
    }
  }

  routeError(cfg: EndpointAdapter, error: RouteError): Response {
    const headers = new Headers({ "Content-Type": "application/json" });
    if (error.accountId) headers.set("X-Provider-Account-Id", error.accountId);
    if (error.retryAfterMs != null && error.retryAfterMs > 0) {
      headers.set("Retry-After", String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))));
    }
    if (cfg.format === "anthropic") {
      const body: Record<string, unknown> = { type: error.type || "invalid_request_error", message: error.message };
      if (error.retryAfter != null) body.retry_after = error.retryAfter;
      if (error.retryAfterMs != null) body.retry_after_ms = error.retryAfterMs;
      return new Response(JSON.stringify({ type: "error", error: body }), { status: error.status, headers });
    }
    const body = {
      error: {
        message: error.message,
        type: error.type || "invalid_request_error",
        param: error.param ?? null,
        code: error.code ?? null,
        ...(error.retryAfter != null ? { retry_after: error.retryAfter } : {}),
        ...(error.retryAfterMs != null ? { retry_after_ms: error.retryAfterMs } : {}),
      },
    };
    return new Response(JSON.stringify(body), { status: error.status, headers });
  }

  private validatePlaygroundAuth(request: Request | undefined): { handled: boolean; result: AuthResult } {
    const emptyResult: AuthResult = {
      valid: false,
      userId: "",
      apiKeyId: "",
      modelAccessMode: "all",
      modelAccessList: [],
      accountAccessMode: "all",
      accountAccessList: [],
      roamingEnabled: false,
      rateLimitRules: [],
      error: "Invalid playground session",
    };
    if (!request) return { handled: false, result: emptyResult };
    const userId = (request.headers.get("x-opendum-playground-user-id") ?? "").trim();
    const timestampValue = (request.headers.get("x-opendum-playground-timestamp") ?? "").trim();
    const signature = (request.headers.get("x-opendum-playground-signature") ?? "").trim();
    if (!userId && !timestampValue && !signature) return { handled: false, result: emptyResult };
    if (!userId || !timestampValue || !signature || !this.deps.secret.trim()) {
      return { handled: true, result: emptyResult };
    }
    const timestamp = Number.parseInt(timestampValue, 10);
    if (!Number.isFinite(timestamp)) return { handled: true, result: emptyResult };
    const requestTime = timestamp * 1000;
    const window = 2 * 60 * 1000;
    if (Date.now() - requestTime > window || requestTime - Date.now() > window) {
      return { handled: true, result: emptyResult };
    }
    let path: string;
    try {
      path = new URL(request.url).pathname;
    } catch {
      path = "/";
    }
    const expected = playgroundSignature(this.deps.secret, userId, timestampValue, request.method, path);
    if (!signaturesMatch(expected, signature)) return { handled: true, result: emptyResult };
    return {
      handled: true,
      result: {
        valid: true,
        userId,
        apiKeyId: "",
        modelAccessMode: "all",
        modelAccessList: [],
        accountAccessMode: "all",
        accountAccessList: [],
        roamingEnabled: false,
        rateLimitRules: [],
        error: "",
      },
    };
  }

  storeHypercreditsUsage(accountId: string, remaining: number | null, cost: number): void {
    storeHypercreditsUsageImpl(this.deps, accountId, remaining, cost);
  }

  recordSuccessfulRequest(params: {
    accountId: string;
    provider: string;
    model: string;
    userId: string;
    apiKeyId: string;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    cacheWriteTokens: number;
    durationMs: number;
    stream: boolean;
    requestStartMs: number;
    upstreamFirstResponseMs: number;
  }): void {
    recordSuccessfulRequestImpl(this.deps, params);
  }

  async quotaCredentials(account: ProviderAccount): Promise<string> {
    return quotaCredentialsImpl(this.deps, account);
  }

  async startTokenRefresher(signal: AbortSignal, intervalMs: number): Promise<void> {
    return startTokenRefresherImpl(this.deps, signal, intervalMs);
  }

  async customProviderForAccount(userId: string, provider: string): Promise<Provider | null> {
    return customProviderForAccountImpl(this.deps, userId, provider);
  }
}

export { extractSessionId } from "./service-helpers.js";

export { cloneMap, numberAsInt, creditSharingPoint, adjustRoamingPoints, roamingPoints };
