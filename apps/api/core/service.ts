import { Cause, Effect, Metric, Result, Schedule } from "effect";
import { databaseFailure } from "@opendum/database";
import type { Database } from "@opendum/database";
import { decrypt, encrypt } from "@opendum/core/crypto";
import type { Registry } from "@opendum/models/runtime";
import type { OpendumRedis } from "@opendum/core/redis";
import { AccountAffinity } from "@opendum/core/redis";
import type { AuthResult, AuthService, ModelValidationResult } from "@opendum/auth";
import {
  adapt,
  compileProvider,
  Ids,
  isRefresher,
  type CredentialRefresher,
  type Provider,
  type ProviderAccount,
  type ProviderRegistry,
  type RefreshedCredentials,
} from "@opendum/providers";
import { Delay, Safe } from "./helpers.js";
import { HeadersTimeout, HEADERS_TIMEOUT_MESSAGE } from "./upstream-timeout.js";
import {
  accessDenial,
  needsRefresh,
  isSynthetic,
  refreshStatus,
  bufferFor,
} from "./service-helpers.js";
import { ProviderPerformance } from "./provider-performance.js";
import { AccountError, FailureMap, ProviderError, ProviderQuota, Workbuddy } from "./errors.js";
import { upsertHistory } from "./error-history.js";
import {
  accountRotations,
  modelSaturationHolds,
  modelSaturationWaits,
  proxyRequestFailures,
  proxyRequests,
  requestDuration,
  tokenRefreshFailures,
  tokenRefreshes,
  upstreamErrors,
  upstreamTtft,
} from "./metrics.js";
import { checkAndIncrement } from "./ratelimit.js";
import { stripImages } from "./content.js";
import {
  adjustRoamingPoints,
  creditSharingPoint,
  roamingPoints,
  type PointReservation,
} from "./points.js";
import { Health, MAX_ERROR_LEN } from "./health.js";
import {
  ModelSaturation,
  SATURATION_MAX_RETRIES,
  MAX_WAIT_MS,
  isSaturated,
  type ModelSaturationOptions,
} from "./model-saturation.js";
import { Rotation } from "./rotation.js";
import { Playground } from "./playground.js";
import { Roaming } from "./roaming.js";
import { trackPending, trackWork } from "./pending.js";
import { Usage } from "./usage-log.js";
import { proxyEvents, type ProxyEvents } from "./events.js";
import { repositories, type PointPort, type Repositories } from "./repositories.js";
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
import { routeFailure } from "./types.js";

const LOCK_PREFIX = "opendum:provider-account:refresh-lock:";
const LOCK_TTL_SECONDS = 120;
const FAIL_PREFIX = "opendum:provider-account:refresh-fail-count:";
const FAIL_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_FAILURES = 5;
const RELEASE_SCRIPT = `if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) end return 0`;
const TRANSIENT_MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1500;

export type TransientRetryOptions = { maxRetries: number; delayMs: number };

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
  saturation?: ModelSaturationOptions;
  retry?: Partial<TransientRetryOptions>;
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
  private readonly saturation: ModelSaturation;
  private readonly retry: TransientRetryOptions;

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
    this.saturation = new ModelSaturation(options.redis, options.saturation);
    this.retry = { maxRetries: TRANSIENT_MAX_RETRIES, delayMs: RETRY_DELAY_MS, ...options.retry };
  }

  get points(): PointPort {
    return this.repositories.points;
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
  ): Effect.Effect<Response, import("@opendum/database").DatabaseFailure> {
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
      if (routeFailure(parsed)) {
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
        const rl = yield* checkAndIncrement(
          this.redis,
          this.models,
          authResult.apiKeyId,
          validation.model,
          validation.alias,
          authResult.rateLimitRules
        );
        if (!rl.allowed) {
          const retry = ProviderError.retryMetadata(rl.retryAfterSeconds * 1000);
          return this.routeError(cfg, {
            status: cfg.rateLimitStatus,
            message: `Rate limit exceeded for ${validation.model}: ${rl.current}/${rl.limit} requests per ${rl.exceededWindow}. Retry after ${rl.retryAfterSeconds}s.`,
            type: "rate_limit_error",
            retryAfter: retry.retryAfter,
            afterMs: retry.afterMs,
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
      if (forced && routeFailure(forced)) {
        return this.routeError(cfg, forced);
      }

      const attempt = yield* this.executeRotation(
        cfg,
        parsedRequest,
        authResult,
        validation,
        forced as ProviderAccount | null,
        startMs,
        sessionId
      ).pipe(
        Effect.catch((failure: { message: string }) =>
          Effect.succeed<RouteError>({
            status: 500,
            message: failure.message,
            type: "api_error",
          })
        )
      );
      if (routeFailure(attempt)) {
        return this.routeError(cfg, attempt);
      }

      const { account, response, requestStartMs, firstResponseMs, rotationFailures, roaming } = attempt;

      const responseCtx: ResponseContext = {
        response,
        accountId: account.id,
        provider: account.provider,
        requestStartMs,
        firstResponseMs,
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
        const result = yield* Effect.tryPromise({
          try: () => cfg.handleStream(responseCtx, this),
          catch: (error) => databaseFailure("handleStream", error),
        });
        if (!responseCtx.streamHandled) {
          if (roaming) {
            yield* Effect.ignore(
              this.roaming.settle(account.userId, roaming, validation.model, responseCtx.usage)
            );
          }
          yield* Effect.ignore(this.health.markRecovered(rotationFailures));
        }
        return result;
      }
      const result = yield* Effect.tryPromise({
        try: () => cfg.handleNonStream(responseCtx, this),
        catch: (error) => databaseFailure("handleNonStream", error),
      }).pipe(
        Effect.catch((failure) =>
          Effect.tryPromise({
            try: () =>
              this.nonStreamFailure(cfg, failure.cause, {
                account,
                authResult,
                validation,
                roaming,
                rotationFailures,
                usage: responseCtx.usage,
                startMs,
              }),
            catch: (error) => databaseFailure("nonStreamFailure", error),
          })
        )
      );
      if (roaming) {
        yield* Effect.ignore(
          this.roaming.settle(account.userId, roaming, validation.model, responseCtx.usage)
        );
      }
      yield* Effect.ignore(this.health.markRecovered(rotationFailures));
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
        trackWork(Effect.ignore(this.roaming.settle(account.userId, roaming, validation.model, usage)));
      } else {
        trackWork(Effect.ignore(this.roaming.refund(roaming)));
      }
    }
    if (reason === "error") {
      trackPending(
        this.recordHandlerFailure(account, authResult, validation, 500, "upstream stream failed", startMs)
      );
    }
    if (reason !== "cancel") {
      trackWork(Effect.ignore(this.health.markRecovered(rotationFailures)));
    }
  }

  private async nonStreamFailure(
    cfg: Adapter,
    error: unknown,
    context: RoamingCompletionContext
  ): Promise<Response> {
    const { account, authResult, validation, roaming, rotationFailures, startMs } = context;
    const message = error instanceof Error ? error.message : String(error);
    if (roaming) await Effect.runPromise(Effect.ignore(this.roaming.refund(roaming)));
    await this.recordHandlerFailure(account, authResult, validation, 500, message, startMs);
    trackWork(Effect.ignore(this.health.markRecovered(rotationFailures)));
    return this.routeError(cfg, {
      status: 500,
      message: ProviderError.prefix(account.provider, message),
      type: "api_error",
      accountId: account.id,
    });
  }

  private async recordHandlerFailure(
    account: ProviderAccount,
    authResult: AuthResult,
    validation: ModelValidationResult,
    statusCode: number,
    message: string,
    startMs: number
  ): Promise<void> {
    await Effect.runPromise(
      Effect.ignore(
        Effect.gen({ self: this }, function* () {
          yield* this.health.markAccountFailed(account.id, validation.model, statusCode, message);
          yield* Effect.promise(() =>
            this.usage.logUsage(authResult, account, validation, statusCode, Date.now() - startMs)
          );
        })
      )
    );
  }

  routeError(cfg: Adapter, error: RouteError): Response {
    void Effect.runFork(Metric.update(proxyRequestFailures, 1));
    return FailureMap.response(error, cfg.format);
  }

  private async modelAccountSelector(
    modelParam: string,
    userId: string
  ): Promise<{ accountId: string; model: string } | null> {
    const index = modelParam.indexOf("/");
    if (index < 0) return null;
    const prefix = modelParam.slice(0, index).trim();
    const model = modelParam.slice(index + 1).trim();
    if (!prefix || !model || this.isKnownPrefix(prefix)) return null;
    if (userId) {
      const custom = await this.repositories.customProviders.getCustomProvider(userId, prefix.toLowerCase());
      if (custom) return null;
    }
    return { accountId: prefix, model };
  }

  private isKnownPrefix(prefix: string): boolean {
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

    const synthetic = this.syntheticAccount(id, userId, validation.model);
    const denial = accessDenial(id, accountAccess);
    if (denial) {
      return { status: 403, message: denial.message, type: "invalid_request_error", param: "model", code: denial.code };
    }
    if (synthetic) {
      const modelErr = await this.validateAccountModel(synthetic, validation, "model");
      if (modelErr) return modelErr;
      return synthetic;
    }

    const row = await Effect.runPromise(this.repositories.accounts.getForcedAccount(id, userId));
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
    const coolingDown = await Effect.runPromise(this.health.refresh(account.id, new Date()));
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
    const modelErr = await this.validateAccountModel(account, validation, "model");
    if (modelErr) return modelErr;
    return account;
  }

  private syntheticAccount(id: string, userId: string, model: string): ProviderAccount | null {
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

  private async isCustomModel(account: ProviderAccount, model: string): Promise<boolean> {
    const custom = await Effect.runPromise(
      this.repositories.customProviders.getCustomProvider(account.userId, account.provider)
    );
    if (!custom) return false;
    const rows = await Effect.runPromise(
      this.repositories.customProviders.customModels(custom.id)
    );
    const target = model.startsWith(`${account.provider}/`)
      ? model.slice(account.provider.length + 1)
      : model;
    return rows.some((row) => row.modelId === model || row.modelId === target);
  }

  private async validateAccountModel(
    account: ProviderAccount,
    validation: ModelValidationResult,
    param: string
  ): Promise<RouteError | null> {
    if (await this.isCustomModel(account, validation.model)) return null;
    if (!this.models.supportsProvider(validation.model, account.provider)) {
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

  private executeRotation(
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
        firstResponseMs: number;
        rotationFailures: Failure[];
        roaming: PointReservation | null;
      }
    | RouteError,
    import("@opendum/database").DatabaseFailure
  > {
    const program = Effect.gen({ self: this }, function* () {
      const tried: string[] = [];
      const sharedTried: string[] = [];
      const excludedProviders: string[] = [];
      const turnId = Ids.uuidV7();
      let useShared = false;
      const recoverableFailures: Failure[] = [];
      let lastFailure: RouteError | null = null;
      let delayedFinalFailure: { account: ProviderAccount; statusCode: number; message: string } | null = null;
      let accountConfigured = false;
      let saturationRetries = 0;
      let transientRetries = 0;
      let transientRetryAccount = "";
      let retryAccount: ProviderAccount | null = null;
      let pendingReservation: PointReservation | null = null;

      for (;;) {
        let account: ProviderAccount | null = retryAccount ?? forced;
        retryAccount = null;
        let roaming: PointReservation | null = pendingReservation;
        pendingReservation = null;
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
            yield* this.health.markAccountFailed(
              pending.account.id,
              validation.model,
              pending.statusCode,
              pending.message
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
              status: cfg.noAccountsStatus,
              message: "No active accounts available for this model. Please add an account in the web UI.",
              type: "configuration_error",
            };
          }
          if (lastFailure) return lastFailure;
          return { status: 503, message: "No available accounts for this request.", type: "api_error" };
        }

        if (useShared && !forced && !roaming) {
          const reserved = yield* this.roaming.reserve(authResult.userId, validation.model);
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

        if (useShared) {
          if (!sharedTried.includes(account.id)) sharedTried.push(account.id);
        } else if (!tried.includes(account.id)) {
          tried.push(account.id);
        }

        const payload = cfg.build(parsed, validation.model, parsed.stream, sessionId);
        if (validation.vision === null || validation.vision === undefined) {
          if (!this.models.isVisionModel(validation.model)) stripImages(payload);
        } else if (!validation.vision) {
          stripImages(payload);
        }

        const requestStartMs = Date.now();
        let firstResponseMs = 0;
        const gateMs = yield* this.saturation.remaining(account.provider, validation.model);
        if (gateMs > 0) {
          if (gateMs <= MAX_WAIT_MS) {
            yield* Metric.update(modelSaturationWaits, 1);
            yield* Effect.promise(() => Delay.sleep(gateMs));
          } else {
            const retry = ProviderError.retryMetadata(gateMs);
            if (roaming) yield* Effect.ignore(this.roaming.refund(roaming));
            return {
              status: 429,
              message: `${account.provider} reports model ${validation.model} as saturated. Retry after ${retry.retryAfter ?? "a moment"}.`,
              type: "rate_limit_error",
              retryAfter: retry.retryAfter,
              afterMs: retry.afterMs,
              accountId: account.id,
            };
          }
        }
        const request = yield* Effect.tryPromise({
          try: () =>
            this.makeProviderRequest(
              account as ProviderAccount,
              payload,
              parsed.stream,
              () => {
                if (firstResponseMs === 0) firstResponseMs = Date.now();
              },
              sessionId,
              turnId
            ),
          catch: (error) => databaseFailure("makeProviderRequest", error),
        }).pipe(Effect.result);

        if (Result.isFailure(request)) {
          delayedFinalFailure = null;
          const status = 500;
          const message = request.failure.message;
          const detailed = AccountError.build(
            message,
            this.errorContext(cfg, validation, parsed, account.provider)
          );
          if (
            !forced &&
            !ProviderError.timeout(message) &&
            (transientRetryAccount !== account.id || transientRetries < this.retry.maxRetries)
          ) {
            if (transientRetryAccount !== account.id) {
              transientRetryAccount = account.id;
              transientRetries = 0;
            }
            transientRetries += 1;
            yield* Effect.ignore(
              Effect.promise(() =>
                this.usage.logUsage(authResult, account, validation, status, Date.now() - startMs)
              )
            );
            yield* Metric.update(upstreamErrors, 1);
            lastFailure = {
              status,
              message: ProviderError.prefix(account.provider, message),
              type: "api_error",
              accountId: account.id,
            };
            yield* Effect.promise(() => Delay.sleep(this.retry.delayMs * transientRetries));
            retryAccount = account;
            pendingReservation = roaming;
            continue;
          }
          const failedAt = yield* this.health.markAccountFailed(
            account.id,
            validation.model,
            status,
            detailed
          ).pipe(Effect.mapError((failure) => databaseFailure("markAccountFailed", failure)));
          yield* Effect.ignore(
            Effect.promise(() =>
              this.usage.logUsage(authResult, account, validation, status, Date.now() - startMs)
            )
          );
          lastFailure = {
            status,
            message: ProviderError.prefix(account.provider, message),
            type: "api_error",
            accountId: account.id,
          };
          yield* Metric.update(upstreamErrors, 1);
          if (roaming) yield* Effect.ignore(this.roaming.refund(roaming));
          if (!forced) {
            recoverableFailures.push({ accountId: account.id, failedAt });
            yield* Metric.update(accountRotations, 1);
            continue;
          }
          return lastFailure;
        }

        const response = request.success;
        if (firstResponseMs === 0) firstResponseMs = Date.now();

        if (response.status < 200 || response.status >= 300) {
          const bodyText = (yield* Effect.promise(() => response.text())).slice(0, 1 << 20);
          let failedAt: Date | null = null;
          delayedFinalFailure = null;
          const providerBadRequest = response.status === 400;
          const fallbackAcrossProviders = providerBadRequest && !forced && validation.provider === null;
          const restrictedUntil = Workbuddy.restrictionUntil(account.provider, bodyText, new Date());
          const usageLimitedUntil = Workbuddy.usageLimitReset(account.provider, bodyText, new Date());
          const detailed = AccountError.build(
            bodyText,
            this.errorContext(cfg, validation, parsed, account.provider)
          );
          const accountFault =
            restrictedUntil !== null ||
            ProviderQuota.codexDisabledUntil(account.provider, response.status, bodyText, new Date()) !== null ||
            ProviderQuota.antigravityExhausted(account.provider, response.status, bodyText);
          const transient =
            !accountFault &&
            (ProviderError.transient(response.status) || Workbuddy.requestFault(account.provider, bodyText));
          const retryable =
            transient &&
            !forced &&
            (transientRetryAccount !== account.id || transientRetries < this.retry.maxRetries);
          if (isSaturated(response.status, bodyText)) {
            yield* Effect.ignore(
              Effect.promise(() =>
                this.usage.logUsage(authResult, account, validation, response.status, Date.now() - startMs)
              )
            );
            yield* Metric.update(upstreamErrors, 1);
            const holdMs = yield* this.saturation.hold(account.provider, validation.model);
            yield* Metric.update(modelSaturationHolds, 1);
            if (!forced && saturationRetries < SATURATION_MAX_RETRIES) {
              saturationRetries += 1;
              yield* Effect.promise(() => Delay.sleep(holdMs));
              retryAccount = account;
              pendingReservation = roaming;
              continue;
            }
            if (roaming) yield* Effect.ignore(this.roaming.refund(roaming));
            const retry = ProviderError.retryMetadata(holdMs);
            return {
              status: 429,
              message: `${account.provider} reports model ${validation.model} as saturated. Retry after ${retry.retryAfter ?? "a moment"}.`,
              type: "rate_limit_error",
              retryAfter: retry.retryAfter,
              afterMs: retry.afterMs,
              accountId: account.id,
            };
          }
          if (!transient && response.status !== 408 && !providerBadRequest) {
            if (!forced && ProviderQuota.antigravityExhausted(account.provider, response.status, bodyText)) {
              delayedFinalFailure = { account, statusCode: response.status, message: detailed };
              yield* this.health.logAccountError(
                account.id,
                account.userId,
                validation.model,
                response.status,
                detailed
              );
            } else if (response.status === 404) {
              yield* this.health.logAccountError(
                account.id,
                account.userId,
                validation.model,
                response.status,
                detailed
              );
            } else {
              failedAt = yield* this.health.markAccountFailed(
                account.id,
                validation.model,
                response.status,
                detailed
              );
              const disabledUntil = ProviderQuota.codexDisabledUntil(
                account.provider,
                response.status,
                bodyText,
                failedAt
              );
              if (disabledUntil) {
                yield* this.health.markUsageLimited(
                  account.id,
                  validation.model,
                  disabledUntil,
                  failedAt as Date
                );
              }
            }
          } else {
            yield* this.health.logAccountError(
              account.id,
              account.userId,
              validation.model,
              response.status,
              detailed
            );
          }
          if (restrictedUntil) {
            yield* this.health.markUsageLimited(
              account.id,
              validation.model,
              restrictedUntil,
              failedAt ?? new Date()
            );
          }
          if (usageLimitedUntil) {
            yield* this.health.markUsageLimited(
              account.id,
              validation.model,
              usageLimitedUntil,
              failedAt ?? new Date()
            );
          }
          yield* Effect.ignore(
            Effect.promise(() =>
              this.usage.logUsage(authResult, account, validation, response.status, Date.now() - startMs)
            )
          );
          const sanitized = ProviderError.sanitize(response.status, bodyText);
          lastFailure = {
            status: response.status,
            message: ProviderError.prefix(account.provider, sanitized.message),
            type: sanitized.type,
            accountId: account.id,
          };
          yield* Metric.update(upstreamErrors, 1);
          yield* Metric.update(upstreamTtft, firstResponseMs - requestStartMs);
          if (retryable) {
            if (transientRetryAccount !== account.id) {
              transientRetryAccount = account.id;
              transientRetries = 0;
            }
            transientRetries += 1;
            yield* Effect.promise(() => Delay.sleep(this.retry.delayMs * transientRetries));
            retryAccount = account;
            pendingReservation = roaming;
            continue;
          }
          if (roaming) yield* Effect.ignore(this.roaming.refund(roaming));
          if (fallbackAcrossProviders) {
            if (!excludedProviders.includes(account.provider)) excludedProviders.push(account.provider);
            continue;
          }
          if ((ProviderError.shouldRotate(response.status) || restrictedUntil !== null) && !forced) {
            if (failedAt) recoverableFailures.push({ accountId: account.id, failedAt });
            yield* Metric.update(accountRotations, 1);
            continue;
          }
          return lastFailure;
        }

        if (forced) this.health.bumpRequest(account.id);
        yield* this.saturation.clear(account.provider, validation.model);
        return {
          account,
          response,
          requestStartMs,
          firstResponseMs,
          rotationFailures: recoverableFailures,
          roaming,
        };
      }
    });
    return program.pipe(
      Effect.catchCause((cause) =>
        Effect.succeed<RouteError>({
          status: 500,
          message: Cause.pretty(cause),
          type: "api_error",
        })
      ),
      Effect.withSpan("ProxyService.rotateAccounts")
    );
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
      endpoint: ProviderError.path(cfg.endpoint),
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
      const loaded = await this.loadCredentials(account);
      return decrypt(this.secret, loaded.accessToken ?? "");
    }
    const resolved = await this.credentialsForAccount(account, providerImpl);
    return resolved.credentials;
  }

  quotaAccount(accountId: string, userId: string, provider: string) {
    return this.repositories.accounts.getQuotaAccount(accountId, userId, provider);
  }

  private async makeProviderRequest(
    account: ProviderAccount,
    payload: Record<string, unknown>,
    stream: boolean,
    onResponseStart: () => void,
    sessionId: string,
    requestId: string
  ): Promise<Response> {
    let providerImpl = this.providers.get(account.provider);
    if (!providerImpl) {
      providerImpl = (await this.customForAccount(account.userId, account.provider)) ?? undefined;
    }
    if (!providerImpl) {
      return new Response(
        JSON.stringify({ error: { message: `provider ${account.provider} is not implemented`, type: "api_error" } }),
        { status: 501, headers: { "Content-Type": "application/json" } }
      );
    }
    const authless = isSynthetic(account.id);
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
      onResponseStart,
      sessionId,
      requestId,
    });
    const response = stream
      ? await this.runStreamRequest(account, request)
      : await this.runBufferedRequest(account, request);
    if (response.status >= 200 && response.status < 300) {
      return adapt(providerImpl as unknown as { responsesNative?(model: string): boolean }, response, payload, stream);
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
    const requestAccount = await this.loadCredentials(account);
    const rawAccessToken = requestAccount.accessToken ?? "";
    const credentials = Safe.sync(() => decrypt(this.secret, rawAccessToken), rawAccessToken);
    const refreshed = await this.refreshIfDue(requestAccount, providerImpl, true);
    if (refreshed.error) {
      if (requestAccount.expiresAt && requestAccount.expiresAt.getTime() < Date.now()) {
        throw refreshed.error;
      }
      return { credentials, account: requestAccount };
    }
    if (refreshed.credentials) return { credentials: refreshed.credentials, account: refreshed.account };
    return { credentials, account: requestAccount };
  }

  private async loadCredentials(account: ProviderAccount): Promise<ProviderAccount> {
    if (account.accessToken && account.refreshToken) return account;
    const row = await Effect.runPromise(
      this.repositories.accounts.credentialsById(account.id)
    );
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

  private async refreshIfDue(
    account: ProviderAccount,
    providerImpl: Provider,
    waitForLock: boolean
  ): Promise<{ credentials: string | null; account: ProviderAccount; error: Error | null }> {
    if (!isRefresher(providerImpl)) return { credentials: null, account, error: null };
    const refresher: CredentialRefresher = providerImpl;
    if (!needsRefresh(account, providerImpl)) return { credentials: null, account, error: null };
    if (!account.refreshToken) {
      if (waitForLock && account.expiresAt && account.expiresAt.getTime() < Date.now()) {
        return { credentials: null, account, error: new Error("provider account token has expired and cannot be refreshed") };
      }
      return { credentials: null, account, error: null };
    }
    const decodedRefreshToken = Safe.result(() => decrypt(this.secret, account.refreshToken as string));
    if (Result.isFailure(decodedRefreshToken)) {
      return { credentials: null, account, error: new Error("failed to decrypt refresh token") };
    }
    if (!decodedRefreshToken.success.trim()) return { credentials: null, account, error: null };

    const lock = await this.acquireRefreshLock(account.id);
    if (!lock.acquired) {
      if (waitForLock && account.expiresAt && account.expiresAt.getTime() < Date.now()) {
        const waited = await this.waitForRefresh(account);
        return waited;
      }
      return { credentials: null, account, error: null };
    }
    return await Effect.runPromise(
      Effect.tryPromise({
        try: async () => {
          const current = await this.credentialsById(account.id);
          if (!needsRefresh(current, providerImpl)) {
            const rawAccessToken = current.accessToken ?? "";
            return {
              credentials: Safe.sync<string | null>(() => decrypt(this.secret, rawAccessToken), null),
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

  private async credentialsById(accountId: string): Promise<ProviderAccount> {
    const row = await Effect.runPromise(
      this.repositories.accounts.credentialsById(accountId)
    );
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
    const acquired = await Safe.async(async () => {
      const result = await this.redis.set(`${LOCK_PREFIX}${accountId}`, value, {
        NX: true,
        EX: LOCK_TTL_SECONDS,
      });
      return Boolean(result);
    }, true);
    return { value, acquired };
  }

  private async releaseRefreshLock(accountId: string, value: string): Promise<void> {
    if (!value) return;
    await Effect.runPromise(
      Effect.ignore(
        Effect.tryPromise({
          try: () =>
            this.redis.eval(RELEASE_SCRIPT, {
              keys: [`${LOCK_PREFIX}${accountId}`],
              arguments: [value],
            }),
          catch: (cause) => cause,
        })
      )
    );
  }

  private async waitForRefresh(
    previous: ProviderAccount
  ): Promise<{ credentials: string | null; account: ProviderAccount; error: Error | null }> {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      await Delay.sleep(250);
      const current = await this.credentialsById(previous.id);
      if (
        current.expiresAt &&
        current.expiresAt.getTime() > Date.now() &&
        (!previous.expiresAt || current.expiresAt.getTime() > previous.expiresAt.getTime())
      ) {
        const rawAccessToken = current.accessToken ?? "";
        return {
          credentials: Safe.sync<string | null>(() => decrypt(this.secret, rawAccessToken), null),
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
    const statusCode = refreshStatus(error);
    const failCount = await Safe.async(async () => {
      const count = await this.redis.incr(`${FAIL_PREFIX}${account.id}`);
      await this.redis.expire(`${FAIL_PREFIX}${account.id}`, FAIL_TTL_SECONDS);
      return count;
    }, 1);
    await Effect.runPromise(
      this.repositories.accounts.recordAccountError({ id: account.id, at: now, code: statusCode })
    );
    const ownerUserId =
      account.userId ||
      (await Effect.runPromise(this.repositories.accounts.ownerId(account.id))) ||
      "";
    if (ownerUserId) {
      await Effect.runPromise(
        upsertHistory(this.redis, account.id, ownerUserId, null, statusCode, `Token refresh failed: ${message}`, now)
      );
    }
    if (failCount >= MAX_FAILURES) {
      await Effect.runPromise(
        this.repositories.accounts.disableFailedAccount({ id: account.id, status: "failed", at: now })
      );
    }
  }

  private async clearRefreshFailures(accountId: string): Promise<void> {
    await Effect.runPromise(
      Effect.ignore(
        Effect.tryPromise({
          try: () => this.redis.del(`${FAIL_PREFIX}${accountId}`),
          catch: (cause) => cause,
        })
      )
    );
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
            const buffer = bufferFor(providerImpl);
            const accounts = yield* this.repositories.accounts
              .expiringAccounts({
                provider: name,
                now,
                expiresBefore: new Date(now.getTime() + buffer),
                batchLimit: 500,
              })
              .pipe(Effect.result);
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
                    try: () => this.refreshIfDue(account, providerImpl, false),
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

  async customForAccount(userId: string, provider: string): Promise<Provider | null> {
    const custom = await Effect.runPromise(
      this.repositories.customProviders.getCustomProvider(userId, provider)
    );
    if (!custom) return null;
    const rows = await Effect.runPromise(
      this.repositories.customProviders.customModels(custom.id)
    );
    return compileProvider({
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


export { sessionKey } from "./service-helpers.js";

export { creditSharingPoint, adjustRoamingPoints, roamingPoints };
