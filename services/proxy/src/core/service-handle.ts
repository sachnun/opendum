import type { AuthResult, AuthService, ModelValidationResult } from "@opendum/auth";
import type { Database } from "@opendum/database";
import type { Registry } from "@opendum/models/runtime";
import type { ProviderAccount, ProviderRegistry } from "@opendum/providers";
import { SessionAffinity, type OpendumRedis } from "@opendum/redis";

import { prefixWithProvider, retryMetadata } from "./transport/errors.ts";
import { refundRoamingPoint, settleRoamingPoint, type PointReservation } from "./metering/points.ts";
import { ProviderPerformance } from "./health/provider-performance.ts";
import { checkAndIncrementAPIKeyRateLimit } from "./metering/ratelimit.ts";
import type { ProxyDeps } from "./service-deps.ts";
import { markAccountsRecoveredByRotation, recordResponseHandlerFailure } from "./health/service-health.ts";
import {
  executeWithAccountRotation,
  modelAccountSelector,
  validateForcedAccount,
} from "./selection/service-routing.ts";
import { routeError as routeErrorImpl } from "./service-errors.ts";
import { validatePlaygroundAuth } from "./service-playground.ts";
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
} from "./types.ts";

export type ProxyServiceOptions = {
  database: Database;
  redis: OpendumRedis;
  models: Registry;
  auth: AuthService;
  providers: ProviderRegistry;
  betterAuthSecret: string;
  requestTimeoutMs: number;
};

export type RoamingCompletionContext = {
  account: ProviderAccount;
  authResult: AuthResult;
  validation: ModelValidationResult;
  roaming: PointReservation | null;
  rotationFailures: AccountRotationFailure[];
  usage: UsageCounts;
  startMs: number;
};

export abstract class ProxyServiceBase {
  protected readonly deps: ProxyDeps;

  protected constructor(options: ProxyServiceOptions) {
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
    const playground = validatePlaygroundAuth(request, this.deps.secret);
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
      const result = await cfg.handleStream(responseCtx, this as unknown as StreamRecorder);
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
      result = await cfg.handleNonStream(responseCtx, this as unknown as StreamRecorder);
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

  protected handleStreamCompletion(reason: StreamCompletion, context: RoamingCompletionContext): void {
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

  protected async handleNonStreamFailure(
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

  protected async refundRoamingPointAsync(reservation: PointReservation): Promise<void> {
    try {
      await refundRoamingPoint(this.deps.database, reservation);
    } catch {
      return;
    }
  }

  protected async settleRoamingPointAsync(
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

  protected async markAccountsRecoveredByRotationDeferred(failures: AccountRotationFailure[]): Promise<void> {
    try {
      await markAccountsRecoveredByRotation(this.deps, failures);
    } catch {
      return;
    }
  }

  routeError(cfg: EndpointAdapter, error: RouteError): Response {
    return routeErrorImpl(cfg, error);
  }
}
