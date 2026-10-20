import { Effect, Metric, Result, Schedule } from "effect";
import type { Database } from "@opendum/database";
import { decrypt, encrypt } from "@opendum/core/crypto";
import type { Registry } from "@opendum/models/runtime";
import type { OpendumRedis } from "@opendum/core/redis";
import { AccountAffinity } from "@opendum/core/redis";
import type { AuthResult, AuthService, ModelValidationResult } from "@opendum/auth";
import {
  adaptForResponsesClient,
  compileCustomProvider,
  isCredentialRefresher,
  randomUuidV7Hex,
  type CredentialRefresher,
  type Provider,
  type ProviderAccount,
  type ProviderRegistry,
  type RefreshedCredentials,
} from "@opendum/providers";
import { cloneMap, numberAsInt, sleep, tryAsync, trySync, trySyncResult } from "./helpers.js";
import { HeadersTimeout, HEADERS_TIMEOUT_MESSAGE } from "./upstream-timeout.js";
import {
  accountAccessDenial,
  accountNeedsCredentialRefresh,
  ignore,
  isSyntheticProviderAccountId,
  parseRefreshErrorStatusCode,
  refreshBufferFor,
} from "./service-helpers.js";
import { ProviderPerformance } from "./provider-performance.js";
import {
  buildAccountErrorMessage,
  codexUsageLimitDisabledUntil,
  endpointPath,
  isAntigravityResourceExhausted,
  prefixWithProvider,
  retryMetadata,
  routeErrorResponse,
  sanitizedProxyError,
  shouldRotate,
  workbuddyRestrictionDisabledUntil,
} from "./errors.js";
import { upsertErrorHistory } from "./error-history.js";
import {
  accountRotations,
  proxyRequestFailures,
  proxyRequests,
  requestDuration,
  tokenRefreshFailures,
  tokenRefreshes,
  upstreamErrors,
  upstreamTtft,
} from "./metrics.js";
import { checkAndIncrementAPIKeyRateLimit } from "./ratelimit.js";
import { stripImageContent } from "./content.js";
import {
  adjustRoamingPoints,
  creditSharingPoint,
  roamingPoints,
  type PointReservation,
} from "./points.js";
import { Health, MAX_ERROR_LEN } from "./health.js";
import { Rotation } from "./rotation.js";
import { Playground } from "./playground.js";
import { Roaming } from "./roaming.js";
import { Usage } from "./usage-log.js";
import { proxyEvents, type ProxyEvents } from "./events.js";
import { repositories, type Repositories } from "./repositories.js";
import type { Adapter } from "./endpoints.js";
import type {
  Failure,
  ParsedEndpointRequest,
  ResponseContext,
  RouteError,
  StreamCompletion,
  StreamRecorder,
  SuccessRecord,
  UsageCounts,
} from "./types.js";
import { isRouteError } from "./types.js";

const TOKEN_REFRESH_LOCK_PREFIX = "opendum:provider-account:refresh-lock:";
const TOKEN_REFRESH_LOCK_TTL_SECONDS = 120;
const REFRESH_FAIL_COUNT_PREFIX = "opendum:provider-account:refresh-fail-count:";
const REFRESH_FAIL_COUNT_TTL_SECONDS = 30 * 24 * 60 * 60;
const REFRESH_MAX_CONSECUTIVE_FAILURES = 5;

export type ProxyServiceOptions = {
  database: Database;
  repositories?: Partial<Repositories>;
  redis: OpendumRedis;
  models: Registry;
  auth: AuthService;
  providers: ProviderRegistry;
  betterAuthSecret: string;
  requestTimeoutMs: number;
  streamTimeoutMs?: number;
  streamHeartbeatMs?: number;
  events?: ProxyEvents;
};

type AccountErrorContext = {
  model: string;
  provider: string;
  endpoint: string;
  messages: unknown;
  parameters: Record<string, unknown>;
};

type RoamingCompletionContext = {
  account: ProviderAccount;
  authResult: AuthResult;
  validation: ModelValidationResult;
  roaming: PointReservation | null;
  rotationFailures: Failure[];
  usage: UsageCounts;
  startMs: number;
};

export class ProxyService implements StreamRecorder {
  private readonly redis: OpendumRedis;
  private readonly models: Registry;
  private readonly auth: AuthService;
  private readonly providers: ProviderRegistry;
  private readonly secret: string;
  private readonly requestTimeoutMs: number;
  private readonly streamTimeoutMs: number;
  private readonly streamHeartbeatMs: number;
  private readonly repositories: Repositories;
  private readonly rotation: Rotation;
  private readonly performance: ProviderPerformance;
  private readonly health: Health;
  private readonly usage: Usage;
  private readonly roaming: Roaming;
  private readonly playground: Playground;

  constructor(options: ProxyServiceOptions) {
    this.redis = options.redis;
    this.models = options.models;
    this.auth = options.auth;
    this.providers = options.providers;
    this.secret = options.betterAuthSecret;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.streamTimeoutMs = options.streamTimeoutMs ?? options.requestTimeoutMs;
    this.streamHeartbeatMs = options.streamHeartbeatMs ?? 0;
    this.repositories = { ...repositories(options.database), ...options.repositories };
    this.performance = new ProviderPerformance(options.redis);
    this.health = new Health({
      accounts: this.repositories.accounts,
      health: this.repositories.health,
      models: options.models,
      redis: options.redis,
    });
    this.rotation = new Rotation({
      accounts: this.repositories.accounts,
      modelHealth: this.repositories.health,
      customProviders: this.repositories.customProviders,
      models: options.models,
      providers: options.providers,
      health: this.health,
      performance: this.performance,
      affinity: new AccountAffinity(options.redis, options.providers.names()),
    });
    this.roaming = new Roaming(this.repositories.points, options.models);
    this.usage = new Usage({
      usage: this.repositories.usage,
      redis: options.redis,
      auth: options.auth,
      models: options.models,
      performance: this.performance,
      health: this.health,
      events: options.events ?? proxyEvents,
    });
    this.playground = new Playground(options.betterAuthSecret);
  }

  handle(
    cfg: Adapter,
    body: Record<string, unknown>,
    authHeader: string,
    sessionId: string,
    request?: Request
  ): Promise<Response> {
    return Effect.runPromise(this.runPipeline(cfg, body, authHeader, sessionId, request));
  }

  runPipeline(
    cfg: Adapter,
    body: Record<string, unknown>,
    authHeader: string,
    sessionId: string,
    request?: Request
  ): Effect.Effect<Response> {
    const startedAt = Date.now();
    return Effect.gen({ self: this }, function* () {
      const startMs = Date.now();
      const playground = this.playground.authenticate(request);
      const authResult = playground.handled
        ? playground.result
        : yield* this.auth.validateKey(authHeader);
      if (!authResult.valid) {
        return this.routeError(cfg, { status: 401, message: authResult.error, type: "authentication_error" });
      }

      const parsed = yield* Effect.sync(() => cfg.parse(body));
      if (isRouteError(parsed)) {
        return this.routeError(cfg, parsed);
      }
      const parsedRequest = parsed;
      const selector = yield* Effect.promise(() =>
        this.modelAccountSelector(parsedRequest.modelParam, authResult.userId)
      );
      if (selector) {
        parsedRequest.forcedAccountId = selector.accountId;
        parsedRequest.modelParam = selector.model;
      }

      const validation = yield* this.auth.validateFor(authResult.userId, parsedRequest.modelParam, {
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
        const rl = yield* Effect.promise(() =>
          checkAndIncrementAPIKeyRateLimit(
            this.redis,
            this.models,
            authResult.apiKeyId,
            validation.model,
            validation.alias,
            authResult.rateLimitRules
          )
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

      const forced = yield* Effect.promise(() =>
        this.validateForcedAccount(
          authResult.userId,
          validation,
          parsedRequest.forcedAccountId,
          { mode: authResult.accountAccessMode, accounts: authResult.accountAccessList },
          playground.handled
        )
      );
      if (forced && isRouteError(forced)) {
        return this.routeError(cfg, forced);
      }

      const attempt = yield* this.executeWithAccountRotation(
        cfg,
        parsedRequest,
        authResult,
        validation,
        forced as ProviderAccount | null,
        startMs,
        sessionId
      );
      if (isRouteError(attempt)) {
        return this.routeError(cfg, attempt);
      }

      const { account, response, requestStartMs, upstreamFirstResponseMs, rotationFailures, roaming } = attempt;

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
        heartbeatMs: this.streamHeartbeatMs,
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
        const result = yield* Effect.promise(() => cfg.handleStream(responseCtx, this));
        if (!responseCtx.streamHandled) {
          if (roaming) {
            yield* ignore(() =>
              this.roaming.settle(account.userId, roaming, validation.model, responseCtx.usage)
            );
          }
          yield* ignore(() => this.health.markRecovered(rotationFailures));
        }
        return result;
      }
      const result = yield* Effect.tryPromise({
        try: () => cfg.handleNonStream(responseCtx, this),
        catch: (error) => error,
      }).pipe(
        Effect.catch((error) =>
          Effect.promise(() =>
            this.handleNonStreamFailure(cfg, error, {
              account,
              authResult,
              validation,
              roaming,
              rotationFailures,
              usage: responseCtx.usage,
              startMs,
            })
          )
        )
      );
      if (roaming) {
        yield* ignore(() =>
          this.roaming.settle(account.userId, roaming, validation.model, responseCtx.usage)
        );
      }
      yield* ignore(() => this.health.markRecovered(rotationFailures));
      return result;
    }).pipe(
      Effect.tap(() => Metric.update(proxyRequests, 1)),
      Effect.tap(() => Metric.update(requestDuration, Date.now() - startedAt)),
      Effect.withSpan("ProxyService.handle", { attributes: { endpoint: cfg.endpoint } })
    );
  }

  private handleStreamCompletion(reason: StreamCompletion, context: RoamingCompletionContext): void {
    const { account, authResult, validation, roaming, rotationFailures, usage, startMs } = context;
    if (roaming) {
      if (reason === "success") {
        void Effect.runFork(ignore(() => this.roaming.settle(account.userId, roaming, validation.model, usage)));
      } else {
        void Effect.runFork(ignore(() => this.roaming.refund(roaming)));
      }
    }
    if (reason === "error") {
      void this.recordResponseHandlerFailure(account, authResult, validation, 500, "upstream stream failed", startMs);
    }
    if (reason !== "cancel") {
      void Effect.runFork(ignore(() => this.health.markRecovered(rotationFailures)));
    }
  }

  private async handleNonStreamFailure(
    cfg: Adapter,
    error: unknown,
    context: RoamingCompletionContext
  ): Promise<Response> {
    const { account, authResult, validation, roaming, rotationFailures, startMs } = context;
    const message = error instanceof Error ? error.message : String(error);
    if (roaming) await Effect.runPromise(ignore(() => this.roaming.refund(roaming)));
    await this.recordResponseHandlerFailure(account, authResult, validation, 500, message, startMs);
    void Effect.runFork(ignore(() => this.health.markRecovered(rotationFailures)));
    return this.routeError(cfg, {
      status: 500,
      message: prefixWithProvider(account.provider, message),
      type: "api_error",
      accountId: account.id,
    });
  }

  private async recordResponseHandlerFailure(
    account: ProviderAccount,
    authResult: AuthResult,
    validation: ModelValidationResult,
    statusCode: number,
    message: string,
    startMs: number
  ): Promise<void> {
    await Effect.runPromise(
      ignore(async () => {
        await this.health.markAccountFailed(account.id, validation.model, statusCode, message);
        await this.usage.logUsage(authResult, account, validation, statusCode, Date.now() - startMs);
      })
    );
  }

  routeError(cfg: Adapter, error: RouteError): Response {
    void Effect.runFork(Metric.update(proxyRequestFailures, 1));
    return routeErrorResponse(error, cfg.format);
  }

  private async modelAccountSelector(
    modelParam: string,
    userId: string
  ): Promise<{ accountId: string; model: string } | null> {
    const index = modelParam.indexOf("/");
    if (index < 0) return null;
    const prefix = modelParam.slice(0, index).trim();
    const model = modelParam.slice(index + 1).trim();
    if (!prefix || !model || this.isKnownModelProviderPrefix(prefix)) return null;
    if (userId) {
      const custom = await this.repositories.customProviders.getCustomProvider(userId, prefix.toLowerCase());
      if (custom) return null;
    }
    return { accountId: prefix, model };
  }

  private isKnownModelProviderPrefix(prefix: string): boolean {
    const provider = prefix.toLowerCase();
    if (this.providers.has(provider)) return true;
    return this.models.models(provider).length > 0;
  }

  private async validateForcedAccount(
    userId: string,
    validation: ModelValidationResult,
    forcedAccountId: string | null,
    accountAccess: { mode: string; accounts: string[] },
    allowInactive = false
  ): Promise<ProviderAccount | RouteError | null> {
    if (!forcedAccountId) return null;
    const id = forcedAccountId.trim();
    if (!id) {
      return {
        status: 400,
        message: "model account selector must include an account prefix",
        type: "invalid_request_error",
        param: "model",
        code: "invalid_provider_account",
      };
    }

    const synthetic = this.syntheticAccountFromId(id, userId, validation.model);
    const denial = accountAccessDenial(id, accountAccess);
    if (denial) {
      return { status: 403, message: denial.message, type: "invalid_request_error", param: "model", code: denial.code };
    }
    if (synthetic) {
      const modelErr = await this.validateSelectedAccountModel(synthetic, validation, "model");
      if (modelErr) return modelErr;
      return synthetic;
    }

    const row = await this.repositories.accounts.getForcedAccount(id, userId);
    if (!row) {
      return {
        status: 400,
        message: "Selected provider account was not found",
        type: "invalid_request_error",
        param: "model",
        code: "provider_account_not_found",
      };
    }
    const account: ProviderAccount = {
      id: row.id,
      userId: row.userId,
      provider: row.provider,
      tier: row.tier,
      accountId: row.accountId,
      status: row.status,
      disabledUntil: row.disabledUntil,
      lastUsedAt: row.lastUsedAt,
      createdAt: row.createdAt,
      isActive: row.isActive,
    };
    const coolingDown = await this.health.refresh(account.id, new Date());
    if (coolingDown) {
      return {
        status: 400,
        message: "Selected provider account is temporarily disabled",
        type: "invalid_request_error",
        param: "model",
        code: "provider_account_temporarily_disabled",
      };
    }
    if (!allowInactive) {
      if (!account.isActive) {
        return {
          status: 400,
          message: "Selected provider account is inactive",
          type: "invalid_request_error",
          param: "model",
          code: "provider_account_inactive",
        };
      }
      if (account.disabledUntil && account.disabledUntil.getTime() > Date.now()) {
        return {
          status: 400,
          message: "Selected provider account is temporarily disabled",
          type: "invalid_request_error",
          param: "model",
          code: "provider_account_temporarily_disabled",
        };
      }
    }
    const modelErr = await this.validateSelectedAccountModel(account, validation, "model");
    if (modelErr) return modelErr;
    return account;
  }

  private syntheticAccountFromId(id: string, userId: string, model: string): ProviderAccount | null {
    if (this.providers.isAuthless(id)) {
      return { id, userId, provider: id, isActive: true, status: "active" };
    }
    if (id.startsWith("authless:")) {
      const provider = id.slice("authless:".length);
      if (provider && this.models.isAuthless(model, provider)) {
        return { id, userId, provider, isActive: true, status: "active" };
      }
    }
    return null;
  }

  private async isCustomAccountModel(account: ProviderAccount, model: string): Promise<boolean> {
    const custom = await this.repositories.customProviders.getCustomProvider(account.userId, account.provider);
    if (!custom) return false;
    const rows = await this.repositories.customProviders.listCustomProviderModels(custom.id);
    const target = model.startsWith(`${account.provider}/`)
      ? model.slice(account.provider.length + 1)
      : model;
    return rows.some((row) => row.modelId === model || row.modelId === target);
  }

  private async validateSelectedAccountModel(
    account: ProviderAccount,
    validation: ModelValidationResult,
    param: string
  ): Promise<RouteError | null> {
    if (await this.isCustomAccountModel(account, validation.model)) return null;
    if (!this.models.isSupportedByProvider(validation.model, account.provider)) {
      return {
        status: 400,
        message: `Selected account provider "${account.provider}" does not support model "${validation.model}"`,
        type: "invalid_request_error",
        param,
        code: "provider_account_model_mismatch",
      };
    }
    if (validation.provider && account.provider !== validation.provider) {
      return {
        status: 400,
        message: `Selected account provider "${account.provider}" does not match model provider "${validation.provider}"`,
        type: "invalid_request_error",
        param,
        code: "provider_account_provider_mismatch",
      };
    }
    if (!this.rotation.canUse(account, validation.model)) {
      return {
        status: 400,
        message: `Selected provider account tier does not allow model "${validation.model}"`,
        type: "invalid_request_error",
        param,
        code: "provider_account_tier_mismatch",
      };
    }
    return null;
  }

  private executeWithAccountRotation(
    cfg: Adapter,
    parsed: ParsedEndpointRequest,
    authResult: AuthResult,
    validation: ModelValidationResult,
    forced: ProviderAccount | null,
    startMs: number,
    sessionId: string
  ): Effect.Effect<
    | {
        account: ProviderAccount;
        response: Response;
        requestStartMs: number;
        upstreamFirstResponseMs: number;
        rotationFailures: Failure[];
        roaming: PointReservation | null;
      }
    | RouteError
  > {
    return Effect.gen({ self: this }, function* () {
      const tried: string[] = [];
      const sharedTried: string[] = [];
      const excludedProviders: string[] = [];
      const turnId = randomUuidV7Hex();
      let useShared = false;
      const recoverableFailures: Failure[] = [];
      let lastFailure: RouteError | null = null;
      let delayedFinalFailure: { account: ProviderAccount; statusCode: number; message: string } | null = null;
      let accountConfigured = false;

      for (;;) {
        let account: ProviderAccount | null = forced;
        let roaming: PointReservation | null = null;
        if (!account) {
          const selection = yield* this.rotation.nextAccount(
            authResult,
            validation,
            tried,
            sharedTried,
            excludedProviders,
            useShared
          );
          accountConfigured = accountConfigured || selection.configured;
          account = selection.account;
        }

        if (!account && !useShared && !forced && authResult.roamingEnabled) {
          useShared = true;
          continue;
        }

        if (!account) {
          if (lastFailure && delayedFinalFailure) {
            const pending = delayedFinalFailure;
            yield* Effect.promise(() =>
              this.health.markAccountFailed(
                pending.account.id,
                validation.model,
                pending.statusCode,
                pending.message
              )
            );
          }
          if (tried.length + sharedTried.length === 0) {
            if (accountConfigured) {
              return {
                status: 503,
                message: "This model is temporarily unavailable. Please try again later.",
                type: "api_error",
              };
            }
            return {
              status: cfg.noAccountsStatusCode,
              message: "No active accounts available for this model. Please add an account in the web UI.",
              type: "configuration_error",
            };
          }
          if (lastFailure) return lastFailure;
          return { status: 503, message: "No available accounts for this request.", type: "api_error" };
        }

        if (useShared && !forced) {
          const reserved = yield* Effect.promise(() =>
            this.roaming.reserve(authResult.userId, validation.model)
          );
          if (!reserved) {
            return {
              status: 402,
              message: "Insufficient points. Please add more points to continue.",
              type: "insufficient_quota",
              code: "insufficient_points",
            };
          }
          roaming = reserved;
        }

        if (useShared) sharedTried.push(account.id);
        else tried.push(account.id);

        const payload = cfg.build(parsed, validation.model, parsed.stream, sessionId);
        if (validation.vision === null || validation.vision === undefined) {
          if (!this.models.isVisionModel(validation.model)) stripImageContent(payload);
        } else if (!validation.vision) {
          stripImageContent(payload);
        }

        const requestStartMs = Date.now();
        let upstreamFirstResponseMs = 0;
        const request = yield* Effect.tryPromise({
          try: () =>
            this.makeProviderRequest(
              account as ProviderAccount,
              payload,
              parsed.stream,
              () => {
                if (upstreamFirstResponseMs === 0) upstreamFirstResponseMs = Date.now();
              },
              sessionId,
              turnId
            ),
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        }).pipe(Effect.result);

        if (Result.isFailure(request)) {
          delayedFinalFailure = null;
          const status = 500;
          const message = request.failure.message;
          const detailed = buildAccountErrorMessage(
            message,
            this.errorContext(cfg, validation, parsed, account.provider)
          );
          const failedAt = yield* Effect.promise(() =>
            this.health.markAccountFailed(account.id, validation.model, status, detailed)
          );
          yield* ignore(() =>
            this.usage.logUsage(authResult, account, validation, status, Date.now() - startMs)
          );
          lastFailure = {
            status,
            message: prefixWithProvider(account.provider, message),
            type: "api_error",
            accountId: account.id,
          };
          yield* Metric.update(upstreamErrors, 1);
          if (roaming) yield* ignore(() => this.roaming.refund(roaming));
          if (!forced) {
            recoverableFailures.push({ accountId: account.id, failedAt });
            yield* Metric.update(accountRotations, 1);
            continue;
          }
          return lastFailure;
        }

        const response = request.success;
        if (upstreamFirstResponseMs === 0) upstreamFirstResponseMs = Date.now();

        if (response.status < 200 || response.status >= 300) {
          const bodyText = (yield* Effect.promise(() => response.text())).slice(0, 1 << 20);
          let failedAt: Date | null = null;
          delayedFinalFailure = null;
          const badRequestFromProvider = response.status === 400;
          const fallbackAcrossProviders = badRequestFromProvider && !forced && validation.provider === null;
          const detailed = buildAccountErrorMessage(
            bodyText,
            this.errorContext(cfg, validation, parsed, account.provider)
          );
          if (response.status !== 408 && !badRequestFromProvider) {
            if (!forced && isAntigravityResourceExhausted(account.provider, response.status, bodyText)) {
              delayedFinalFailure = { account, statusCode: response.status, message: detailed };
              yield* Effect.promise(() =>
                this.health.logAccountError(account.id, account.userId, validation.model, response.status, detailed)
              );
            } else {
              failedAt = yield* Effect.promise(() =>
                this.health.markAccountFailed(account.id, validation.model, response.status, detailed)
              );
              const disabledUntil = codexUsageLimitDisabledUntil(
                account.provider,
                response.status,
                bodyText,
                failedAt
              );
              if (disabledUntil) {
                yield* Effect.promise(() =>
                  this.health.markAccountUsageLimited(account.id, validation.model, disabledUntil, failedAt as Date)
                );
              }
            }
          } else {
            yield* Effect.promise(() =>
              this.health.logAccountError(account.id, account.userId, validation.model, response.status, detailed)
            );
          }
          const restrictedUntil = workbuddyRestrictionDisabledUntil(account.provider, bodyText, new Date());
          if (restrictedUntil) {
            yield* Effect.promise(() =>
              this.health.markAccountUsageLimited(account.id, validation.model, restrictedUntil, failedAt ?? new Date())
            );
          }
          yield* ignore(() =>
            this.usage.logUsage(authResult, account, validation, response.status, Date.now() - startMs)
          );
          const sanitized = sanitizedProxyError(response.status, bodyText);
          lastFailure = {
            status: response.status,
            message: prefixWithProvider(account.provider, sanitized.message),
            type: sanitized.type,
            accountId: account.id,
          };
          yield* Metric.update(upstreamErrors, 1);
          yield* Metric.update(upstreamTtft, upstreamFirstResponseMs - requestStartMs);
          if (roaming) yield* ignore(() => this.roaming.refund(roaming));
          if (fallbackAcrossProviders) {
            if (!excludedProviders.includes(account.provider)) excludedProviders.push(account.provider);
            continue;
          }
          if ((shouldRotate(response.status) || restrictedUntil !== null) && !forced) {
            if (failedAt) recoverableFailures.push({ accountId: account.id, failedAt });
            yield* Metric.update(accountRotations, 1);
            continue;
          }
          return lastFailure;
        }

        if (forced) this.health.bumpRequest(account.id);
        return {
          account,
          response,
          requestStartMs,
          upstreamFirstResponseMs,
          rotationFailures: recoverableFailures,
          roaming,
        };
      }
    }).pipe(Effect.withSpan("ProxyService.rotateAccounts"));
  }

  private errorContext(
    cfg: Adapter,
    validation: ModelValidationResult,
    parsed: ParsedEndpointRequest,
    provider: string
  ): AccountErrorContext {
    return {
      model: validation.model,
      provider,
      endpoint: endpointPath(cfg.endpoint),
      messages: parsed.messagesForError,
      parameters: parsed.paramsForError,
    };
  }

  storeCredits(accountId: string, remaining: number | null, cost: number): void {
    this.usage.storeCredits(accountId, remaining, cost);
  }

  recordSuccess(params: SuccessRecord): void {
    this.usage.recordSuccess(params);
  }

  async quotaCredentials(account: ProviderAccount): Promise<string> {
    const providerImpl = this.providers.get(account.provider);
    if (!providerImpl) {
      const loaded = await this.loadProviderAccountCredentials(account);
      return decrypt(this.secret, loaded.accessToken ?? "");
    }
    const resolved = await this.credentialsForAccount(account, providerImpl);
    return resolved.credentials;
  }

  async quotaAccount(accountId: string, userId: string, provider: string) {
    return this.repositories.accounts.getQuotaAccount(accountId, userId, provider);
  }

  private async makeProviderRequest(
    account: ProviderAccount,
    payload: Record<string, unknown>,
    stream: boolean,
    onUpstreamResponseStart: () => void,
    sessionId: string,
    requestId: string
  ): Promise<Response> {
    let providerImpl = this.providers.get(account.provider);
    if (!providerImpl) {
      providerImpl = (await this.customProviderForAccount(account.userId, account.provider)) ?? undefined;
    }
    if (!providerImpl) {
      return new Response(
        JSON.stringify({ error: { message: `provider ${account.provider} is not implemented`, type: "api_error" } }),
        { status: 501, headers: { "Content-Type": "application/json" } }
      );
    }
    const authless = isSyntheticProviderAccountId(account.id);
    let credentials = "";
    let requestAccount = account;
    if (!authless) {
      const resolved = await this.credentialsForAccount(account, providerImpl);
      credentials = resolved.credentials;
      requestAccount = resolved.account;
    }
    const request = providerImpl.makeRequest({
      account: requestAccount,
      credentials,
      body: payload,
      stream,
      onUpstreamResponseStart,
      sessionId,
      requestId,
    });
    const response = stream
      ? await this.runStreamRequest(account, request)
      : await this.runBufferedRequest(account, request);
    if (response.status >= 200 && response.status < 300) {
      return adaptForResponsesClient(providerImpl as unknown as { responsesNative?(model: string): boolean }, response, payload, stream);
    }
    return response;
  }

  private runBufferedRequest(
    account: ProviderAccount,
    request: Effect.Effect<Response, unknown>
  ): Promise<Response> {
    if (this.requestTimeoutMs <= 0) {
      return Effect.runPromise(request.pipe(this.requestSpan(account)));
    }
    return Effect.runPromise(
      request.pipe(
        Effect.timeoutOrElse({
          duration: this.requestTimeoutMs,
          orElse: () => Effect.fail(new Error("upstream request timed out")),
        }),
        this.requestSpan(account)
      )
    );
  }

  private runStreamRequest(
    account: ProviderAccount,
    request: Effect.Effect<Response, unknown>
  ): Promise<Response> {
    if (this.streamTimeoutMs <= 0) {
      return Effect.runPromise(request.pipe(this.requestSpan(account)));
    }
    return Effect.runPromise(
      Effect.suspend(() => {
        const timeout = new HeadersTimeout(this.streamTimeoutMs);
        return request.pipe(
          Effect.raceFirst(
            Effect.callback<Response, Error>((resume) => {
              if (timeout.signal.aborted) {
                resume(Effect.fail(new Error(HEADERS_TIMEOUT_MESSAGE)));
                return;
              }
              const onAbort = (): void => {
                resume(Effect.fail(new Error(HEADERS_TIMEOUT_MESSAGE)));
              };
              timeout.signal.addEventListener("abort", onAbort, { once: true });
              return Effect.sync(() => timeout.signal.removeEventListener("abort", onAbort));
            })
          ),
          Effect.ensuring(Effect.sync(() => timeout.clear())),
          this.requestSpan(account)
        );
      })
    );
  }

  private requestSpan(account: ProviderAccount) {
    return Effect.withSpan("ProxyService.providerRequest", {
      attributes: { provider: account.provider, accountId: account.id },
    });
  }

  private async credentialsForAccount(
    account: ProviderAccount,
    providerImpl: Provider
  ): Promise<{ credentials: string; account: ProviderAccount }> {
    const requestAccount = await this.loadProviderAccountCredentials(account);
    const rawAccessToken = requestAccount.accessToken ?? "";
    const credentials = trySync(() => decrypt(this.secret, rawAccessToken), rawAccessToken);
    const refreshed = await this.refreshAccountCredentialsIfDue(requestAccount, providerImpl, true);
    if (refreshed.error) {
      if (requestAccount.expiresAt && requestAccount.expiresAt.getTime() < Date.now()) {
        throw refreshed.error;
      }
      return { credentials, account: requestAccount };
    }
    if (refreshed.credentials) return { credentials: refreshed.credentials, account: refreshed.account };
    return { credentials, account: requestAccount };
  }

  private async loadProviderAccountCredentials(account: ProviderAccount): Promise<ProviderAccount> {
    if (account.accessToken && account.refreshToken) return account;
    const row = await this.repositories.accounts.getAccountCredentialsByID(account.id);
    if (!row) return account;
    return {
      id: row.id,
      userId: row.userId,
      provider: row.provider,
      accessToken: row.accessToken,
      refreshToken: row.refreshToken,
      expiresAt: row.expiresAt,
      accountId: row.accountId,
      projectId: row.projectId,
      tier: row.tier,
      email: row.email,
      isActive: row.isActive,
    };
  }

  private async refreshAccountCredentialsIfDue(
    account: ProviderAccount,
    providerImpl: Provider,
    waitForLock: boolean
  ): Promise<{ credentials: string | null; account: ProviderAccount; error: Error | null }> {
    if (!isCredentialRefresher(providerImpl)) return { credentials: null, account, error: null };
    const refresher: CredentialRefresher = providerImpl;
    if (!accountNeedsCredentialRefresh(account, providerImpl)) return { credentials: null, account, error: null };
    if (!account.refreshToken) {
      if (waitForLock && account.expiresAt && account.expiresAt.getTime() < Date.now()) {
        return { credentials: null, account, error: new Error("provider account token has expired and cannot be refreshed") };
      }
      return { credentials: null, account, error: null };
    }
    const decodedRefreshToken = trySyncResult(() => decrypt(this.secret, account.refreshToken as string));
    if (Result.isFailure(decodedRefreshToken)) {
      return { credentials: null, account, error: new Error("failed to decrypt refresh token") };
    }
    if (!decodedRefreshToken.success.trim()) return { credentials: null, account, error: null };

    const lock = await this.acquireRefreshLock(account.id);
    if (!lock.acquired) {
      if (waitForLock && account.expiresAt && account.expiresAt.getTime() < Date.now()) {
        const waited = await this.waitForRefreshedAccount(account);
        return waited;
      }
      return { credentials: null, account, error: null };
    }
    return await Effect.runPromise(
      Effect.tryPromise({
        try: async () => {
          const current = await this.loadProviderAccountCredentialsByID(account.id);
          if (!accountNeedsCredentialRefresh(current, providerImpl)) {
            const rawAccessToken = current.accessToken ?? "";
            return {
              credentials: trySync<string | null>(() => decrypt(this.secret, rawAccessToken), null),
              account: current,
              error: null,
            };
          }
          if (!current.refreshToken) return { credentials: null, account: current, error: null };
          const rotatedToken = decrypt(this.secret, current.refreshToken);
          void Effect.runFork(Metric.update(tokenRefreshes, 1));
          const refreshed = await Effect.runPromise(refresher.refreshCredentials(rotatedToken, current));
          const updated = await this.persistRefreshedCredentials(current, refreshed);
          await this.clearRefreshFailures(current.id);
          return { credentials: refreshed.accessToken, account: updated, error: null };
        },
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      }).pipe(
        Effect.catch((error) =>
          Effect.promise(async () => {
            void Effect.runFork(Metric.update(tokenRefreshFailures, 1));
            await this.recordRefreshFailure(account, error);
            return { credentials: null, account, error };
          })
        ),
        Effect.ensuring(Effect.promise(() => this.releaseRefreshLock(account.id, lock.value)))
      )
    );
  }

  private async loadProviderAccountCredentialsByID(accountId: string): Promise<ProviderAccount> {
    const row = await this.repositories.accounts.getAccountCredentialsByID(accountId);
    if (!row) throw new Error("provider account not found");
    return {
      id: row.id,
      userId: row.userId,
      provider: row.provider,
      accessToken: row.accessToken,
      refreshToken: row.refreshToken,
      expiresAt: row.expiresAt,
      accountId: row.accountId,
      projectId: row.projectId,
      tier: row.tier,
      email: row.email,
      isActive: row.isActive,
    };
  }

  private async persistRefreshedCredentials(
    account: ProviderAccount,
    refreshed: RefreshedCredentials
  ): Promise<ProviderAccount> {
    if (!refreshed.accessToken || !refreshed.refreshToken || !refreshed.expiresAt) {
      throw new Error("provider token refresh returned incomplete credentials");
    }
    const storeAccessToken = refreshed.storeAccessToken?.trim() || refreshed.accessToken;
    const encryptedAccess = encrypt(this.secret, storeAccessToken);
    const encryptedRefresh = encrypt(this.secret, refreshed.refreshToken);
    const projectId = refreshed.projectId ? refreshed.projectId : account.projectId ?? null;
    let tier = account.tier ?? null;
    if (refreshed.tier) tier = refreshed.tier;
    if (refreshed.paidTier) tier = refreshed.paidTier;
    const email = refreshed.email ? refreshed.email : account.email ?? null;
    const accountId = refreshed.accountId ? refreshed.accountId : account.accountId ?? null;
    await this.repositories.accounts.updateRefreshedCredentials(
      {
        id: account.id,
        accessToken: encryptedAccess,
        refreshToken: encryptedRefresh,
        expiresAt: refreshed.expiresAt,
        projectId,
        tier,
        email,
        accountId,
      }
    );
    return {
      ...account,
      accessToken: encryptedAccess,
      refreshToken: encryptedRefresh,
      expiresAt: refreshed.expiresAt,
      projectId,
      tier,
      email,
      accountId,
    };
  }

  private async acquireRefreshLock(accountId: string): Promise<{ value: string; acquired: boolean }> {
    const value = crypto.randomUUID();
    const acquired = await tryAsync(async () => {
      const result = await this.redis.set(`${TOKEN_REFRESH_LOCK_PREFIX}${accountId}`, value, {
        NX: true,
        EX: TOKEN_REFRESH_LOCK_TTL_SECONDS,
      });
      return Boolean(result);
    }, true);
    return { value, acquired };
  }

  private async releaseRefreshLock(accountId: string, value: string): Promise<void> {
    void value;
    await Effect.runPromise(ignore(() => this.redis.del(`${TOKEN_REFRESH_LOCK_PREFIX}${accountId}`)));
  }

  private async waitForRefreshedAccount(
    previous: ProviderAccount
  ): Promise<{ credentials: string | null; account: ProviderAccount; error: Error | null }> {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      await sleep(250);
      const current = await this.loadProviderAccountCredentialsByID(previous.id);
      if (
        current.expiresAt &&
        current.expiresAt.getTime() > Date.now() &&
        (!previous.expiresAt || current.expiresAt.getTime() > previous.expiresAt.getTime())
      ) {
        const rawAccessToken = current.accessToken ?? "";
        return {
          credentials: trySync<string | null>(() => decrypt(this.secret, rawAccessToken), null),
          account: current,
          error: null,
        };
      }
    }
    return { credentials: null, account: previous, error: new Error("provider account token refresh is already in progress") };
  }

  private async recordRefreshFailure(account: ProviderAccount, error: Error): Promise<void> {
    if (!account.isActive) return;
    const now = new Date();
    const message = error.message.length > MAX_ERROR_LEN ? error.message.slice(0, MAX_ERROR_LEN) : error.message;
    const statusCode = parseRefreshErrorStatusCode(error);
    const failCount = await tryAsync(async () => {
      const count = await this.redis.incr(`${REFRESH_FAIL_COUNT_PREFIX}${account.id}`);
      await this.redis.expire(`${REFRESH_FAIL_COUNT_PREFIX}${account.id}`, REFRESH_FAIL_COUNT_TTL_SECONDS);
      return count;
    }, 1);
    await this.repositories.accounts.recordAccountError({ id: account.id, at: now, code: statusCode });
    const ownerUserId = account.userId || (await this.repositories.accounts.getAccountOwnerUserID(account.id)) || "";
    if (ownerUserId) {
      await upsertErrorHistory(this.redis, account.id, ownerUserId, null, statusCode, `Token refresh failed: ${message}`, now);
    }
    if (failCount >= REFRESH_MAX_CONSECUTIVE_FAILURES) {
      await this.repositories.accounts.disableFailedAccount({ id: account.id, status: "failed", at: now });
    }
  }

  private async clearRefreshFailures(accountId: string): Promise<void> {
    await Effect.runPromise(ignore(() => this.redis.del(`${REFRESH_FAIL_COUNT_PREFIX}${accountId}`)));
  }

  refreshTokenLoop(intervalMs: number): Effect.Effect<void, never> {
    return Effect.repeat(
      Effect.promise(() => this.runTokenRefresh()),
      Schedule.spaced(intervalMs)
    ).pipe(Effect.asVoid);
  }

  private async runTokenRefresh(): Promise<void> {
    await Effect.runPromise(
      Effect.tryPromise({
        try: () => this.refreshExpiringTokens(),
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      }).pipe(
        Effect.catch((error) =>
          Effect.logError("token refresh cycle failed", { cause: error }).pipe(
            Effect.withSpan("ProxyService.tokenRefresh")
          )
        )
      )
    );
  }

  private async refreshExpiringTokens(): Promise<void> {
    const names = this.providers.refreshableProviderNames();
    if (names.length === 0) return;
    const now = new Date();
    await Effect.runPromise(
      Effect.forEach(
        names,
        (name) =>
          Effect.gen({ self: this }, function* () {
            const providerImpl = this.providers.get(name);
            if (!providerImpl) return;
            const buffer = refreshBufferFor(providerImpl);
            const accounts = yield* Effect.tryPromise({
              try: () =>
                this.repositories.accounts.listExpiringRefreshableAccounts(
                  { provider: name, now, expiresBefore: new Date(now.getTime() + buffer), batchLimit: 500 }
                ),
              catch: (error) => (error instanceof Error ? error : new Error(String(error))),
            }).pipe(Effect.result);
            if (accounts._tag === "Failure") {
              yield* Effect.logError(`token refresh query failed for provider ${name}`, {
                cause: accounts.failure,
              });
              return;
            }
            yield* Effect.forEach(
              accounts.success,
              (row) =>
                Effect.gen({ self: this }, function* () {
                  const account: ProviderAccount = {
                    id: row.id,
                    userId: row.userId,
                    provider: row.provider,
                    accessToken: row.accessToken,
                    refreshToken: row.refreshToken,
                    expiresAt: row.expiresAt,
                    accountId: row.accountId,
                    projectId: row.projectId,
                    tier: row.tier,
                    email: row.email,
                    isActive: row.isActive,
                  };
                  yield* Effect.tryPromise({
                    try: () => this.refreshAccountCredentialsIfDue(account, providerImpl, false),
                    catch: () => new Error("token refresh failed"),
                  }).pipe(Effect.ignore);
                }),
              { concurrency: 8 }
            );
          }),
        { concurrency: 4 }
      ).pipe(Effect.withSpan("ProxyService.refreshExpiringTokens"))
    );
  }

  async customProviderForAccount(userId: string, provider: string): Promise<Provider | null> {
    const custom = await this.repositories.customProviders.getCustomProvider(userId, provider);
    if (!custom) return null;
    const rows = await this.repositories.customProviders.listCustomProviderModels(custom.id);
    return compileCustomProvider({
      provider: { slug: custom.slug, baseUrl: custom.baseUrl, extraHeaders: custom.extraHeaders ?? null },
      models: rows.map((row) => ({
        modelId: row.modelId,
        upstream: row.upstream,
        authless: row.authless,
        customFlags: row.customFlags ?? null,
      })),
      transport: this.providers.transport,
      fallback: null,
    });
  }
}


export { extractSessionId } from "./service-helpers.js";

export { cloneMap, numberAsInt, creditSharingPoint, adjustRoamingPoints, roamingPoints };
