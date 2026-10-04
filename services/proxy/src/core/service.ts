import { createHash, randomUUID } from "node:crypto";

import {
  bumpAccountRequestCount,
  deactivateAPIKey,
  disableFailedAccount,
  getAccountCredentialsByID,
  getAccountHealthState,
  getAccountOwnerUserID,
  getForcedAccount,
  getModelHealth,
  getCustomProvider,
  listCustomProviderModels,
  listCustomProviders,
  insertModelHealth,
  insertUsageLog,
  listDisabledAccountIDs,
  listEligibleAccounts,
  listExpiringRefreshableAccounts,
  listModelHealthByAccount,
  listModelHealthByAccounts,
  listSharedEligibleAccounts,
  markAccountRecoveredByRotation,
  markAccountSuccess,
  markUsageLimitedHealth,
  recordAccountError,
  recordRequestError,
  setAccountActive,
  setAccountCooldown,
  setAccountHealthFailed,
  setAccountUsageLimited,
  updateModelHealthCounters,
  updateModelHealthFailure,
  updateModelHealthFailureWithStatus,
  updateModelHealthStatus,
  updateModelHealthSuccess,
  updateModelHealthSuccessWithStatus,
  updateRefreshedCredentials,
} from "@opendum/database/queries";
import type { Database } from "@opendum/database";
import { decrypt, encrypt, playgroundSignature, signaturesMatch } from "@opendum/crypto";
import type { Registry } from "@opendum/models/runtime";
import type { OpendumRedis } from "@opendum/redis";
import { SessionAffinity, preferSticky } from "@opendum/redis";
import type { AuthResult, AuthService, ModelValidationResult } from "@opendum/auth";
import {
  adaptForResponsesClient,
  compileCustomProvider,
  isCredentialRefresher,
  type CredentialRefresher,
  type Provider,
  type ProviderAccount,
  type ProviderRegistry,
  type RefreshedCredentials,
} from "@opendum/providers";
import { cloneMap, numberAsInt, sleep, stringValue } from "./helpers.js";
import {
  buildAccountErrorMessage,
  codexUsageLimitDisabledUntil,
  endpointPath,
  isAntigravityResourceExhausted,
  prefixWithProvider,
  retryMetadata,
  sanitizedProxyError,
  shouldRotate,
} from "./errors.js";
import { upsertErrorHistory } from "./error-history.js";
import { checkAndIncrementAPIKeyRateLimit } from "./ratelimit.js";
import { stripImageContent } from "./content.js";
import {
  adjustRoamingPoints,
  creditSharingPoint,
  refundRoamingPoint,
  reserveRoamingPoint,
  roamingPoints,
  settleRoamingPoint,
  type PointReservation,
} from "./points.js";
import type {
  AccountRotationFailure,
  EndpointAdapter,
  ParsedEndpointRequest,
  ResponseContext,
  RouteError,
  StreamRecorder,
  UsageCounts,
} from "./types.js";

const AUTHLEless_PREFIX = "authless:";
const FAILED_COOLDOWN_MS = 10 * 60 * 1000;
const UNHEALTHY_IDLE_DECAY_MS = 10 * 60 * 1000;
const MODEL_DEGRADED_THRESHOLD = 2;
const ACCOUNT_COOLDOWN_UNHEALTHY_THRESHOLD = 10;
const COOLDOWN_RECOVERY_RATIO = 0.3;
const MAX_STORED_ERROR_LEN = 10000;
const TOKEN_REFRESH_LOCK_PREFIX = "opendum:provider-account:refresh-lock:";
const TOKEN_REFRESH_LOCK_TTL_SECONDS = 120;
const REFRESH_FAIL_COUNT_PREFIX = "opendum:provider-account:refresh-fail-count:";
const REFRESH_FAIL_COUNT_TTL_SECONDS = 30 * 24 * 60 * 60;
const REFRESH_MAX_CONSECUTIVE_FAILURES = 5;
const HYPERCREDITS_BALANCE_PREFIX = "opendum:hypercredits:balance:";
const HYPERCREDITS_BALANCE_TTL_SECONDS = 30 * 24 * 60 * 60;

export type ProxyServiceOptions = {
  database: Database;
  redis: OpendumRedis;
  models: Registry;
  auth: AuthService;
  providers: ProviderRegistry;
  betterAuthSecret: string;
  requestTimeoutMs: number;
};

type AccountErrorContext = {
  model: string;
  provider: string;
  endpoint: string;
  messages: unknown;
  parameters: Record<string, unknown>;
};

export class ProxyService implements StreamRecorder {
  private readonly database: Database;
  private readonly redis: OpendumRedis;
  private readonly models: Registry;
  private readonly auth: AuthService;
  private readonly providers: ProviderRegistry;
  private readonly secret: string;
  private readonly requestTimeoutMs: number;
  private readonly affinity: SessionAffinity;

  constructor(options: ProxyServiceOptions) {
    this.database = options.database;
    this.redis = options.redis;
    this.models = options.models;
    this.auth = options.auth;
    this.providers = options.providers;
    this.secret = options.betterAuthSecret;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.affinity = new SessionAffinity(options.redis, options.providers.names());
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
      authResult = await this.auth.validateAPIKey(authHeader);
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
    const selector = await this.modelAccountSelector(parsedRequest.modelParam, authResult.userId);
    if (selector) {
      parsedRequest.forcedAccountId = selector.accountId;
      parsedRequest.modelParam = selector.model;
    }

    const validation = await this.auth.validateModelForUser(
      authResult.userId,
      parsedRequest.modelParam,
      {
        mode: authResult.modelAccessMode,
        models: authResult.modelAccessList,
        roamingEnabled: authResult.roamingEnabled,
      }
    );
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
        this.redis,
        this.models,
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

    const forced = await this.validateForcedAccount(
      authResult.userId,
      validation,
      parsedRequest.forcedAccountId,
      { mode: authResult.accountAccessMode, accounts: authResult.accountAccessList },
      playground.handled
    );
    if (forced && "status" in forced && typeof (forced as RouteError).status === "number") {
      return this.routeError(cfg, forced as RouteError);
    }

    const attempt = await this.executeWithAccountRotation(
      cfg,
      parsedRequest,
      authResult,
      validation,
      (forced as ProviderAccount | null),
      startMs,
      sessionId
    );
    if ("status" in attempt && typeof attempt.status === "number") {
      const routeError = attempt as RouteError;
      if (routeError.accountId) {
        // account id is surfaced through the error body only
      }
      return this.routeError(cfg, routeError);
    }

    const { account, response, requestStartMs, upstreamFirstResponseMs, rotationFailures, roaming } =
      attempt as Exclude<typeof attempt, RouteError>;

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
      const result = await cfg.handleStream(responseCtx, this);
      if (roaming) await this.settleRoamingPointAsync(account.userId, roaming, validation.model, responseCtx.usage);
      void this.markAccountsRecoveredByRotationDeferred(rotationFailures);
      return result;
    }
    const result = await cfg.handleNonStream(responseCtx, this);
    if (roaming) await this.settleRoamingPointAsync(account.userId, roaming, validation.model, responseCtx.usage);
    void this.markAccountsRecoveredByRotationDeferred(rotationFailures);
    return result;
  }

  private async settleRoamingPointAsync(
    ownerUserId: string,
    roaming: PointReservation,
    model: string,
    usage: UsageCounts
  ): Promise<void> {
    try {
      await settleRoamingPoint(this.database, this.models, ownerUserId, roaming, model, usage);
    } catch {
      return;
    }
  }

  private async markAccountsRecoveredByRotationDeferred(failures: AccountRotationFailure[]): Promise<void> {
    try {
      await this.markAccountsRecoveredByRotation(failures);
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
      const custom = await getCustomProvider(userId, prefix.toLowerCase(), this.database);
      if (custom) return null;
    }
    return { accountId: prefix, model };
  }

  private isKnownModelProviderPrefix(prefix: string): boolean {
    const provider = prefix.toLowerCase();
    if (this.providers.has(provider)) return true;
    return this.models.modelsForProvider(provider).length > 0;
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

    const row = await getForcedAccount(id, userId, this.database);
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
    const coolingDown = await this.refreshAccountHealthFromModels(account.id, new Date());
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
      if (provider && this.models.isAuthlessProviderModel(model, provider)) {
        return { id, userId, provider, isActive: true, status: "active" };
      }
    }
    return null;
  }

  private async customProviderSlugsForModel(userId: string, model: string): Promise<string[]> {
    const providers = await listCustomProviders(userId, this.database);
    if (providers.length === 0) return [];
    const canonical = this.models.resolveAlias(model);
    const slugs: string[] = [];
    for (const custom of providers) {
      const rows = await listCustomProviderModels(custom.id, this.database);
      if (rows.some((row) => row.aliased && this.models.resolveAlias(row.modelId) === canonical)) {
        slugs.push(custom.slug);
      }
    }
    return slugs;
  }

  private async isCustomAccountModel(account: ProviderAccount, model: string): Promise<boolean> {
    const custom = await getCustomProvider(account.userId, account.provider, this.database);
    if (!custom) return false;
    const rows = await listCustomProviderModels(custom.id, this.database);
    const target = model.startsWith(`${account.provider}/`)
      ? model.slice(account.provider.length + 1)
      : model;
    return rows.some((row) => row.modelId === model || row.modelId === target);
  }

  private canAccountUseModel(account: ProviderAccount, model: string): boolean {
    const rule = this.models.providerAccessRule(model, account.provider);
    if (!rule || !proxyAccessRuleRestrictsTier(rule.minTier, rule.allowedTiers)) return true;
    const tier = account.tier ?? quotaFallbackTierLocal(account);
    return proxyTierSatisfiesRule(tier, rule.minTier, rule.allowedTiers);
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
    if (!this.canAccountUseModel(account, validation.model)) {
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

  private async executeWithAccountRotation(
    cfg: EndpointAdapter,
    parsed: ParsedEndpointRequest,
    authResult: AuthResult,
    validation: ModelValidationResult,
    forced: ProviderAccount | null,
    startMs: number,
    sessionId: string
  ): Promise<
    | {
        account: ProviderAccount;
        response: Response;
        requestStartMs: number;
        upstreamFirstResponseMs: number;
        rotationFailures: AccountRotationFailure[];
        roaming: PointReservation | null;
      }
    | RouteError
  > {
    const tried: string[] = [];
    const sharedTried: string[] = [];
    let excludedProviders: string[] = [];
    let useShared = false;
    const recoverableFailures: AccountRotationFailure[] = [];
    let lastFailure: RouteError | null = null;
    let delayedFinalFailure: { account: ProviderAccount; statusCode: number; message: string } | null = null;
    let accountConfigured = false;

    for (;;) {
      let account: ProviderAccount | null = forced;
      let roaming: PointReservation | null = null;
      if (!account) {
        const selection = await this.nextAttemptAccount(
          authResult,
          validation,
          tried,
          sharedTried,
          excludedProviders,
          useShared,
          sessionId
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
          await this.markAccountFailed(delayedFinalFailure.account.id, validation.model, delayedFinalFailure.statusCode, delayedFinalFailure.message);
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
            message: "No active accounts available for this model. Please add an account in the dashboard.",
            type: "configuration_error",
          };
        }
        if (lastFailure) return lastFailure;
        return { status: 503, message: "No available accounts for this request.", type: "api_error" };
      }

      if (useShared && !forced) {
        const reserved = await reserveRoamingPoint(this.database, authResult.userId, validation.model);
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
      let response: Response;
      try {
        response = await this.makeProviderRequest(
          account,
          payload,
          parsed.stream,
          () => {
            if (upstreamFirstResponseMs === 0) upstreamFirstResponseMs = Date.now();
          }
        );
      } catch (error) {
        delayedFinalFailure = null;
        const status = 500;
        const message = error instanceof Error ? error.message : String(error);
        const detailed = buildAccountErrorMessage(message, this.errorContext(cfg, validation, parsed, account.provider));
        const failedAt = await this.markAccountFailed(account.id, validation.model, status, detailed);
        await this.logUsage(authResult, account, validation, status, Date.now() - startMs);
        lastFailure = {
          status,
          message: prefixWithProvider(account.provider, message),
          type: "api_error",
          accountId: account.id,
        };
        if (roaming) await refundRoamingPoint(this.database, roaming);
        if (!forced) {
          recoverableFailures.push({ accountId: account.id, failedAt });
          continue;
        }
        return lastFailure;
      }

      if (upstreamFirstResponseMs === 0) upstreamFirstResponseMs = Date.now();

      if (response.status < 200 || response.status >= 300) {
        const bodyText = (await response.text()).slice(0, 1 << 20);
        let failedAt: Date | null = null;
        delayedFinalFailure = null;
        const badRequestFromProvider = response.status === 400;
        const fallbackAcrossProviders = badRequestFromProvider && !forced && validation.provider === null;
        const detailed = buildAccountErrorMessage(bodyText, this.errorContext(cfg, validation, parsed, account.provider));
        if (response.status !== 408 && !badRequestFromProvider) {
          if (!forced && isAntigravityResourceExhausted(account.provider, response.status, bodyText)) {
            delayedFinalFailure = { account, statusCode: response.status, message: detailed };
            await this.logAccountError(account.id, account.userId, validation.model, response.status, detailed);
          } else {
            failedAt = await this.markAccountFailed(account.id, validation.model, response.status, detailed);
            const disabledUntil = codexUsageLimitDisabledUntil(account.provider, response.status, bodyText, failedAt);
            if (disabledUntil) await this.markAccountUsageLimited(account.id, validation.model, disabledUntil, failedAt);
          }
        } else {
          await this.logAccountError(account.id, account.userId, validation.model, response.status, detailed);
        }
        await this.logUsage(authResult, account, validation, response.status, Date.now() - startMs);
        const sanitized = sanitizedProxyError(response.status, bodyText);
        lastFailure = {
          status: response.status,
          message: prefixWithProvider(account.provider, sanitized.message),
          type: sanitized.type,
          accountId: account.id,
        };
        if (roaming) await refundRoamingPoint(this.database, roaming);
        if (fallbackAcrossProviders) {
          if (!excludedProviders.includes(account.provider)) excludedProviders.push(account.provider);
          continue;
        }
        if (shouldRotate(response.status) && !forced) {
          if (failedAt) recoverableFailures.push({ accountId: account.id, failedAt });
          continue;
        }
        return lastFailure;
      }

      if (forced) void this.bumpAccountRequestCountDeferred(account.id);
      return { account, response, requestStartMs, upstreamFirstResponseMs, rotationFailures: recoverableFailures, roaming };
    }
  }

  private errorContext(
    cfg: EndpointAdapter,
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

  private async nextAttemptAccount(
    authResult: AuthResult,
    validation: ModelValidationResult,
    tried: string[],
    sharedTried: string[],
    excludedProviders: string[],
    useShared: boolean,
    sessionId: string
  ): Promise<{ account: ProviderAccount | null; configured: boolean }> {
    if (useShared) {
      const result = await this.getNextSharedAccount(
        authResult.userId,
        validation.model,
        validation.provider,
        sharedTried,
        excludedProviders
      );
      return { account: result.account, configured: result.configured };
    }
    return this.getNextAvailableAccount(
      authResult.userId,
      validation.model,
      validation.provider,
      tried,
      excludedProviders,
      { mode: authResult.accountAccessMode, accounts: authResult.accountAccessList },
      sessionId
    );
  }

  private async getEligibleAccounts(
    userId: string,
    model: string,
    provider: string | null,
    exclude: string[],
    excludeProviders: string[],
    accountAccess: { mode: string; accounts: string[] }
  ): Promise<ProviderAccount[]> {
    const targetProviders = provider
      ? [provider]
      : [...new Set([...this.models.providersForModel(model), ...(await this.customProviderSlugsForModel(userId, model))])];
    if (targetProviders.length === 0) return [];

    const rows: ProviderAccount[] = [];
    for (const targetProvider of targetProviders) {
      let account: ProviderAccount | null = null;
      if (this.providers.isAuthless(targetProvider)) {
        account = { id: targetProvider, userId: "", provider: targetProvider, isActive: true, status: "active" };
      } else if (this.models.isAuthlessProviderModel(model, targetProvider)) {
        account = {
          id: `authless:${targetProvider}`,
          userId: "",
          provider: targetProvider,
          isActive: true,
          status: "active",
        };
      }
      if (!account) continue;
      if (exclude.includes(account.id)) continue;
      if (excludeProviders.includes(account.provider)) continue;
      if (accountAccessDenial(account.id, accountAccess)) continue;
      rows.push(account);
    }

    const now = new Date();
    const mode = normalizeAccessMode(accountAccess.mode);
    const accounts = normalizeAccountIds(accountAccess.accounts);
    const dbRows = await listEligibleAccounts(
      {
        userId,
        providers: targetProviders,
        now,
        excludeIds: exclude,
        excludeProviders,
        useWhitelist: mode === "whitelist" && accounts.length > 0,
        accountIds: accounts,
        useBlacklist: mode === "blacklist" && accounts.length > 0,
      },
      this.database
    );
    for (const row of dbRows) {
      rows.push({
        id: row.id,
        userId: row.userId,
        provider: row.provider,
        tier: row.tier,
        accountId: row.accountId,
        status: row.status,
        disabledUntil: row.disabledUntil,
        lastUsedAt: row.lastUsedAt,
        createdAt: row.createdAt,
      });
    }
    if (rows.length === 0) return [];

    const lookupKeys = this.models.lookupKeys(model);
    const ids = rows.map((row) => row.id);
    const disabled = await listDisabledAccountIDs({ accountIds: ids, models: lookupKeys }, this.database);
    const disabledSet = new Set(disabled.map((row) => row.providerAccountId));
    const enabled = rows.filter(
      (row) => isSyntheticProviderAccountId(row.id) || (!disabledSet.has(row.id) && this.canAccountUseModel(row, model))
    );
    if (provider === null) sortAccountsByProviderPriority(enabled, targetProviders);
    return enabled;
  }

  private async getNextAvailableAccount(
    userId: string,
    model: string,
    provider: string | null,
    exclude: string[],
    excludeProviders: string[],
    accountAccess: { mode: string; accounts: string[] },
    sessionId: string
  ): Promise<{ account: ProviderAccount | null; configured: boolean }> {
    const eligible = await this.getEligibleAccounts(userId, model, provider, exclude, excludeProviders, accountAccess);
    if (eligible.length === 0) return { account: null, configured: false };
    let prioritized = prioritizeAccounts(eligible, provider === null, this.models.providersForModel(model));
    const stickyId = await this.affinity.lookup(userId, sessionId);
    if (stickyId && !isSyntheticProviderAccountId(stickyId)) {
      prioritized = preferSticky(prioritized, (account) => account.id === stickyId);
    }
    const selected = await this.pickHealthyAccount(prioritized, model);
    if (!selected) return { account: null, configured: true };
    await this.rememberAffinityAccount(userId, sessionId, selected);
    return { account: selected, configured: true };
  }

  private async getNextSharedAccount(
    _userId: string,
    model: string,
    provider: string | null,
    exclude: string[],
    excludeProviders: string[]
  ): Promise<{ account: ProviderAccount | null; configured: boolean }> {
    const targetProviders = provider ? [provider] : this.models.providersForModel(model);
    if (targetProviders.length === 0) return { account: null, configured: false };
    const now = new Date();
    const sharedRows = await listSharedEligibleAccounts(
      { userId: _userId, providers: targetProviders, now, excludeIds: exclude, excludeProviders },
      this.database
    );
    const rows: ProviderAccount[] = sharedRows.map((row) => ({
      id: row.id,
      userId: row.userId,
      provider: row.provider,
      tier: row.tier,
      accountId: row.accountId,
      status: row.status,
      disabledUntil: row.disabledUntil,
      lastUsedAt: row.lastUsedAt,
      createdAt: row.createdAt,
    }));
    if (rows.length === 0) return { account: null, configured: false };
    const lookupKeys = this.models.lookupKeys(model);
    const ids = rows.map((row) => row.id);
    const disabled = await listDisabledAccountIDs({ accountIds: ids, models: lookupKeys }, this.database);
    const disabledSet = new Set(disabled.map((row) => row.providerAccountId));
    const enabled = rows.filter((row) => !disabledSet.has(row.id) && this.canAccountUseModel(row, model));
    if (enabled.length === 0) return { account: null, configured: true };
    const prioritized = prioritizeAccounts(enabled, provider === null, targetProviders);
    return { account: await this.pickHealthyAccount(prioritized, model), configured: true };
  }

  private async pickHealthyAccount(
    prioritized: ProviderAccount[],
    model: string
  ): Promise<ProviderAccount | null> {
    const now = new Date();
    const lookupKeys = this.models.lookupKeys(model);
    let degraded: ProviderAccount | null = null;
    for (const account of prioritized) {
      if (isSyntheticProviderAccountId(account.id)) return account;
      const coolingDown = await this.refreshAccountHealthFromModels(account.id, now);
      if (coolingDown) continue;
      const health = await getModelHealth(account.id, this.models.resolveAlias(model), this.database);
      if (health && health.status === "degraded") {
        if (!degraded) degraded = account;
        continue;
      }
      void lookupKeys;
      void this.bumpAccountRequestCountDeferred(account.id);
      return account;
    }
    if (degraded) void this.bumpAccountRequestCountDeferred(degraded.id);
    return degraded;
  }

  private async bumpAccountRequestCountDeferred(accountId: string): Promise<void> {
    if (isSyntheticProviderAccountId(accountId)) return;
    try {
      await bumpAccountRequestCount({ id: accountId, at: new Date() }, this.database);
    } catch {
      return;
    }
  }

  private async refreshAccountHealthFromModels(accountId: string, now: Date): Promise<boolean> {
    if (isSyntheticProviderAccountId(accountId)) return false;
    const account = await getAccountHealthState(accountId, this.database);
    if (!account) return false;
    const rows = await listModelHealthByAccount(accountId, this.database);
    const applyCooldownRecovery =
      account.status === "failed" && account.disabledUntil !== null && account.disabledUntil.getTime() <= now.getTime();
    const total = await this.normalizeModelHealthRows(rows, now, applyCooldownRecovery);

    if (account.disabledUntil && account.disabledUntil.getTime() > now.getTime()) {
      if (account.consecutiveErrors !== total) {
        await setAccountHealthFailed(
          { id: accountId, consecutiveErrors: total, status: "failed", at: now },
          this.database
        );
      }
      return true;
    }
    if (total >= ACCOUNT_COOLDOWN_UNHEALTHY_THRESHOLD) {
      await setAccountCooldown(
        {
          id: accountId,
          status: "failed",
          at: now,
          consecutiveErrors: total,
          disabledUntil: new Date(now.getTime() + FAILED_COOLDOWN_MS),
        },
        this.database
      );
      return true;
    }
    if (
      account.status !== "active" ||
      (account.disabledUntil !== null && account.disabledUntil.getTime() <= now.getTime()) ||
      account.consecutiveErrors !== total
    ) {
      await setAccountActive({ id: accountId, status: "active", at: now, consecutiveErrors: total }, this.database);
    }
    return false;
  }

  private async normalizeModelHealthRows(
    rows: Awaited<ReturnType<typeof listModelHealthByAccount>>,
    now: Date,
    applyCooldownRecovery: boolean
  ): Promise<number> {
    let total = 0;
    for (const row of rows) {
      let count = effectiveUnhealthyCount(row, now);
      if (applyCooldownRecovery) count = cooldownRecoveryCount(count);
      const status = modelHealthStatus(count);
      const statusChanged = status !== row.status;
      total += count;
      if (count === row.consecutiveErrors && !statusChanged && !applyCooldownRecovery) continue;
      if (row.status === "failed" || statusChanged) {
        await updateModelHealthStatus(
          { id: row.id, consecutiveErrors: count, unhealthyCountUpdatedAt: now, status, statusChangedAt: now },
          this.database
        );
        continue;
      }
      await updateModelHealthCounters(
        { id: row.id, consecutiveErrors: count, unhealthyCountUpdatedAt: now },
        this.database
      );
    }
    return total;
  }

  async markAccountSuccess(accountId: string, model: string): Promise<void> {
    if (isSyntheticProviderAccountId(accountId)) return;
    const now = new Date();
    await markAccountSuccess({ id: accountId, at: now }, this.database);
    const resolved = this.models.resolveAlias(model);
    const health = await getModelHealth(accountId, resolved, this.database);
    if (!health) {
      await this.refreshAccountHealthFromModels(accountId, now);
      return;
    }
    const nextErrors = successRecoveryCount(health, now);
    const nextStatus = modelHealthStatus(nextErrors);
    if (nextStatus !== health.status) {
      await updateModelHealthSuccessWithStatus(
        {
          id: health.id,
          consecutiveErrors: nextErrors,
          lastSuccessAt: now,
          unhealthyCountUpdatedAt: now,
          status: nextStatus,
          statusChangedAt: now,
        },
        this.database
      );
    } else {
      await updateModelHealthSuccess(
        { id: health.id, consecutiveErrors: nextErrors, lastSuccessAt: now, unhealthyCountUpdatedAt: now },
        this.database
      );
    }
    await this.refreshAccountHealthFromModels(accountId, now);
  }

  async markAccountFailed(accountId: string, model: string, statusCode: number, message: string): Promise<Date> {
    const now = new Date();
    if (isSyntheticProviderAccountId(accountId)) return now;
    const stored = message.length > MAX_STORED_ERROR_LEN ? message.slice(0, MAX_STORED_ERROR_LEN) : message;
    await recordRequestError({ id: accountId, at: now, code: statusCode }, this.database);
    const resolved = this.models.resolveAlias(model);
    const health = await getModelHealth(accountId, resolved, this.database);
    if (health) {
      const nextErrors = effectiveUnhealthyCount(health, now) + 1;
      const nextStatus = modelHealthStatus(nextErrors);
      if (nextStatus !== health.status) {
        await updateModelHealthFailureWithStatus(
          {
            id: health.id,
            consecutiveErrors: nextErrors,
            lastErrorAt: now,
            lastErrorCode: statusCode,
            unhealthyCountUpdatedAt: now,
            status: nextStatus,
            statusChangedAt: now,
          },
          this.database
        );
      } else {
        await updateModelHealthFailure(
          {
            id: health.id,
            consecutiveErrors: nextErrors,
            lastErrorAt: now,
            lastErrorCode: statusCode,
            unhealthyCountUpdatedAt: now,
          },
          this.database
        );
      }
    } else {
      const nextErrors = 1;
      await insertModelHealth(
        {
          id: randomUUID(),
          providerAccountId: accountId,
          model: resolved,
          consecutiveErrors: nextErrors,
          status: modelHealthStatus(nextErrors),
          lastErrorAt: now,
          lastErrorCode: statusCode,
          unhealthyCountUpdatedAt: now,
          createdAt: now,
          updatedAt: now,
        },
        this.database
      );
    }
    await this.refreshAccountHealthFromModels(accountId, now);
    const ownerUserId = await getAccountOwnerUserID(accountId, this.database);
    if (ownerUserId) {
      await upsertErrorHistory(this.redis, accountId, ownerUserId, resolved, statusCode, stored, now);
    }
    return now;
  }

  async markAccountUsageLimited(accountId: string, model: string, disabledUntil: Date, failedAt: Date): Promise<void> {
    if (isSyntheticProviderAccountId(accountId)) return;
    const resolved = this.models.resolveAlias(model);
    await markUsageLimitedHealth(
      {
        providerAccountId: accountId,
        model: resolved,
        status: "failed",
        at: failedAt,
        consecutiveErrors: ACCOUNT_COOLDOWN_UNHEALTHY_THRESHOLD,
      },
      this.database
    );
    await this.refreshAccountHealthFromModels(accountId, failedAt);
    await setAccountUsageLimited(
      { id: accountId, disabledUntil, status: "failed", at: failedAt },
      this.database
    );
  }

  async markAccountsRecoveredByRotation(failures: AccountRotationFailure[]): Promise<void> {
    const latest = new Map<string, Date>();
    for (const failure of failures) {
      const existing = latest.get(failure.accountId);
      if (!existing || failure.failedAt.getTime() > existing.getTime()) latest.set(failure.accountId, failure.failedAt);
    }
    if (latest.size === 0) return;
    const recoveredAt = new Date();
    for (const [accountId, failedAt] of latest) {
      if (isSyntheticProviderAccountId(accountId)) continue;
      await markAccountRecoveredByRotation({ id: accountId, at: recoveredAt, beforeOrAt: failedAt }, this.database);
    }
  }

  async logAccountError(accountId: string, userId: string, model: string, statusCode: number, message: string): Promise<void> {
    if (isSyntheticProviderAccountId(accountId)) return;
    const stored = message.length > MAX_STORED_ERROR_LEN ? message.slice(0, MAX_STORED_ERROR_LEN) : message;
    const resolved = this.models.resolveAlias(model);
    await upsertErrorHistory(this.redis, accountId, userId, resolved, statusCode, stored, new Date());
  }

  private async logUsage(
    authResult: AuthResult,
    account: ProviderAccount,
    validation: ModelValidationResult,
    statusCode: number,
    durationMs: number
  ): Promise<void> {
    await this.logUsageRaw({
      userId: authResult.userId,
      providerAccountId: account.id,
      proxyApiKeyId: authResult.apiKeyId,
      model: validation.model,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      statusCode,
      durationMs,
    });
  }

  async logUsageRaw(params: {
    userId: string;
    providerAccountId: string;
    proxyApiKeyId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    cacheWriteTokens: number;
    statusCode: number;
    durationMs: number;
  }): Promise<void> {
    if (!params.userId || !params.model) return;
    const providerAccountId = params.providerAccountId && !isSyntheticProviderAccountId(params.providerAccountId)
      ? params.providerAccountId
      : null;
    try {
      await insertUsageLog(
        {
          id: randomUUID(),
          userId: params.userId,
          providerAccountId,
          proxyApiKeyId: params.proxyApiKeyId || null,
          model: params.model,
          inputTokens: params.inputTokens,
          outputTokens: params.outputTokens,
          cachedTokens: params.cachedTokens,
          cacheWriteTokens: params.cacheWriteTokens,
          statusCode: params.statusCode,
          duration: params.durationMs,
          createdAt: new Date(),
        },
        this.database
      );
      await this.auth.bumpAnalyticsCacheVersionThrottled(params.userId);
    } catch {
      return;
    }
  }

  private async recordLatency(provider: string, model: string, stream: boolean, latencyMs: number): Promise<void> {
    if (latencyMs <= 0) return;
    const mode = stream ? "stream" : "nonstream";
    const key = `opendum:latency:${provider}:${model.trim().toLowerCase()}:${mode}`;
    const now = Date.now();
    try {
      await this.redis.zAdd(key, { score: now, value: `${latencyMs}:${now}` });
      await this.redis.zRemRangeByRank(key, 0, -101);
      await this.redis.expire(key, 24 * 60 * 60);
    } catch {
      return;
    }
  }

  private validatePlaygroundAuth(
    request: Request | undefined
  ): { handled: boolean; result: AuthResult } {
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
    if (!userId || !timestampValue || !signature || !this.secret.trim()) {
      return { handled: true, result: emptyResult };
    }
    const timestamp = Number.parseInt(timestampValue, 10);
    if (!Number.isFinite(timestamp)) return { handled: true, result: emptyResult };
    const requestTime = timestamp * 1000;
    const window = 2 * 60 * 1000;
    if (Date.now() - requestTime > window || requestTime - Date.now() > window) {
      return { handled: true, result: emptyResult };
    }
    let path = "/";
    try {
      path = new URL(request.url).pathname;
    } catch {
      path = "/";
    }
    const expected = playgroundSignature(this.secret, userId, timestampValue, request.method, path);
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
    if (!accountId) return;
    void (async () => {
      try {
        const key = HYPERCREDITS_BALANCE_PREFIX + accountId;
        if (remaining !== null && remaining > 0) {
          await this.redis.set(key, String(remaining), { EX: HYPERCREDITS_BALANCE_TTL_SECONDS });
          return;
        }
        if (cost > 0) {
          const raw = await this.redis.get(key);
          const current = raw === null ? Number.NaN : Number(raw);
          if (Number.isFinite(current) && current > 0) {
            const next = Math.max(0, current - cost);
            await this.redis.set(key, String(next), { EX: HYPERCREDITS_BALANCE_TTL_SECONDS });
          }
        }
      } catch {
        return;
      }
    })();
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
    void (async () => {
      try {
        await this.markAccountSuccess(params.accountId, params.model);
        if (params.upstreamFirstResponseMs > params.requestStartMs) {
          await this.recordLatency(
            params.provider,
            params.model,
            params.stream,
            params.upstreamFirstResponseMs - params.requestStartMs
          );
        }
        await this.logUsageRaw({
          userId: params.userId,
          providerAccountId: params.accountId,
          proxyApiKeyId: params.apiKeyId,
          model: params.model,
          inputTokens: params.inputTokens,
          outputTokens: params.outputTokens,
          cachedTokens: params.cachedTokens,
          cacheWriteTokens: params.cacheWriteTokens,
          statusCode: 200,
          durationMs: params.durationMs,
        });
      } catch {
        return;
      }
    })();
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

  private async makeProviderRequest(
    account: ProviderAccount,
    payload: Record<string, unknown>,
    stream: boolean,
    onUpstreamResponseStart: () => void
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
    });
    const response =
      !stream && this.requestTimeoutMs > 0 ? await withTimeout(request, this.requestTimeoutMs) : await request;
    if (response.status >= 200 && response.status < 300) {
      return adaptForResponsesClient(providerImpl as unknown as { responsesNative?(model: string): boolean }, response, payload, stream);
    }
    return response;
  }

  private async credentialsForAccount(
    account: ProviderAccount,
    providerImpl: Provider
  ): Promise<{ credentials: string; account: ProviderAccount }> {
    const requestAccount = await this.loadProviderAccountCredentials(account);
    let credentials: string;
    try {
      credentials = decrypt(this.secret, requestAccount.accessToken ?? "");
    } catch {
      credentials = requestAccount.accessToken ?? "";
    }
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
    const row = await getAccountCredentialsByID(account.id, this.database);
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
    let refreshToken: string;
    try {
      refreshToken = decrypt(this.secret, account.refreshToken);
    } catch {
      return { credentials: null, account, error: new Error("failed to decrypt refresh token") };
    }
    if (!refreshToken.trim()) return { credentials: null, account, error: null };

    const lock = await this.acquireRefreshLock(account.id);
    if (!lock.acquired) {
      if (waitForLock && account.expiresAt && account.expiresAt.getTime() < Date.now()) {
        const waited = await this.waitForRefreshedAccount(account);
        return waited;
      }
      return { credentials: null, account, error: null };
    }
    try {
      const current = await this.loadProviderAccountCredentialsByID(account.id);
      if (!accountNeedsCredentialRefresh(current, providerImpl)) {
        try {
          const credentials = decrypt(this.secret, current.accessToken ?? "");
          return { credentials, account: current, error: null };
        } catch {
          return { credentials: null, account: current, error: null };
        }
      }
      if (!current.refreshToken) return { credentials: null, account: current, error: null };
      refreshToken = decrypt(this.secret, current.refreshToken);
      const refreshed = await refresher.refreshCredentials(refreshToken, current);
      const updated = await this.persistRefreshedCredentials(current, refreshed);
      await this.clearRefreshFailures(current.id);
      return { credentials: refreshed.accessToken, account: updated, error: null };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      await this.recordRefreshFailure(account, err);
      return { credentials: null, account, error: err };
    } finally {
      await this.releaseRefreshLock(account.id, lock.value);
    }
  }

  private async loadProviderAccountCredentialsByID(accountId: string): Promise<ProviderAccount> {
    const row = await getAccountCredentialsByID(accountId, this.database);
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
    await updateRefreshedCredentials(
      {
        id: account.id,
        accessToken: encryptedAccess,
        refreshToken: encryptedRefresh,
        expiresAt: refreshed.expiresAt,
        projectId,
        tier,
        email,
        accountId,
      },
      this.database
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
    const value = randomUUID();
    try {
      const result = await this.redis.set(`${TOKEN_REFRESH_LOCK_PREFIX}${accountId}`, value, {
        NX: true,
        EX: TOKEN_REFRESH_LOCK_TTL_SECONDS,
      });
      return { value, acquired: Boolean(result) };
    } catch {
      return { value, acquired: true };
    }
  }

  private async releaseRefreshLock(accountId: string, value: string): Promise<void> {
    try {
      await this.redis.del(`${TOKEN_REFRESH_LOCK_PREFIX}${accountId}`);
    } catch {
      void value;
    }
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
        try {
          return { credentials: decrypt(this.secret, current.accessToken ?? ""), account: current, error: null };
        } catch {
          return { credentials: null, account: current, error: null };
        }
      }
    }
    return { credentials: null, account: previous, error: new Error("provider account token refresh is already in progress") };
  }

  private async recordRefreshFailure(account: ProviderAccount, error: Error): Promise<void> {
    if (!account.isActive) return;
    const now = new Date();
    const message = error.message.length > MAX_STORED_ERROR_LEN ? error.message.slice(0, MAX_STORED_ERROR_LEN) : error.message;
    const statusCode = parseRefreshErrorStatusCode(error);
    let failCount = 1;
    try {
      failCount = await this.redis.incr(`${REFRESH_FAIL_COUNT_PREFIX}${account.id}`);
      await this.redis.expire(`${REFRESH_FAIL_COUNT_PREFIX}${account.id}`, REFRESH_FAIL_COUNT_TTL_SECONDS);
    } catch {
      failCount = 1;
    }
    await recordAccountError({ id: account.id, at: now, code: statusCode }, this.database);
    const ownerUserId = account.userId || (await getAccountOwnerUserID(account.id, this.database)) || "";
    if (ownerUserId) {
      await upsertErrorHistory(this.redis, account.id, ownerUserId, null, statusCode, `Token refresh failed: ${message}`, now);
    }
    if (failCount >= REFRESH_MAX_CONSECUTIVE_FAILURES) {
      await disableFailedAccount({ id: account.id, status: "failed", at: now }, this.database);
    }
  }

  private async clearRefreshFailures(accountId: string): Promise<void> {
    try {
      await this.redis.del(`${REFRESH_FAIL_COUNT_PREFIX}${accountId}`);
    } catch {
      return;
    }
  }

  private async rememberAffinityAccount(
    userId: string,
    sessionId: string,
    account: ProviderAccount
  ): Promise<void> {
    if (!sessionId || isSyntheticProviderAccountId(account.id)) return;
    if (!this.affinity.enabled(account.provider)) return;
    await this.affinity.store(userId, sessionId, account.id);
  }

  async startTokenRefresher(signal: AbortSignal, intervalMs: number): Promise<void> {
    if (intervalMs <= 0) return;
    await this.refreshExpiringTokens();
    const timer = setInterval(() => void this.refreshExpiringTokens(), intervalMs);
    timer.unref?.();
    signal.addEventListener("abort", () => clearInterval(timer));
  }

  private async refreshExpiringTokens(): Promise<void> {
    const names = this.providers.refreshableProviderNames();
    if (names.length === 0) return;
    const now = new Date();
    for (const name of names) {
      const providerImpl = this.providers.get(name);
      if (!providerImpl) continue;
      const buffer = refreshBufferFor(providerImpl);
      const accounts = await listExpiringRefreshableAccounts(
        { provider: name, now, expiresBefore: new Date(now.getTime() + buffer), batchLimit: 500 },
        this.database
      );
      for (const row of accounts) {
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
        try {
          await this.refreshAccountCredentialsIfDue(account, providerImpl, false);
        } catch {
          continue;
        }
      }
    }
  }

  async customProviderForAccount(userId: string, provider: string): Promise<Provider | null> {
    const {
      getCustomProvider,
      listCustomProviderModels,
    } = await import("@opendum/database/queries");
    const custom = await getCustomProvider(userId, provider, this.database);
    if (!custom) return null;
    const rows = await listCustomProviderModels(custom.id, this.database);
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

function isSyntheticProviderAccountId(accountId: string): boolean {
  return accountId === "opencode" || accountId.startsWith(AUTHLEless_PREFIX);
}

function normalizeAccessMode(mode: string): string {
  return mode === "whitelist" || mode === "blacklist" ? mode : "all";
}

function normalizeAccountIds(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter((v) => v.length > 0))].sort((a, b) => a.localeCompare(b));
}

function accountAccessDenial(
  accountId: string,
  access: { mode: string; accounts: string[] }
): { message: string; code: string } | null {
  const mode = normalizeAccessMode(access.mode);
  const set = new Set(normalizeAccountIds(access.accounts));
  if (mode === "whitelist" && !set.has(accountId)) {
    return { message: "Selected provider account is not allowed for this API key.", code: "provider_account_not_whitelisted" };
  }
  if (mode === "blacklist" && set.has(accountId)) {
    return { message: "Selected provider account is blocked for this API key.", code: "provider_account_blacklisted" };
  }
  return null;
}

function refreshBufferFor(provider: Provider): number {
  const candidate = provider as unknown as { refreshBuffer?: () => number };
  if (typeof candidate.refreshBuffer === "function") {
    return candidate.refreshBuffer();
  }
  return 3 * 60 * 60 * 1000;
}

function accountNeedsCredentialRefresh(account: ProviderAccount, provider: Provider): boolean {
  if (!account.expiresAt) return false;
  return Date.now() > account.expiresAt.getTime() - refreshBufferFor(provider);
}

function parseRefreshErrorStatusCode(error: Error): number {
  const message = error.message;
  for (let i = 0; i + 3 <= message.length; i += 1) {
    const ch = message[i];
    if (ch < "4" || ch > "5") continue;
    if (message[i + 1] < "0" || message[i + 1] > "9" || message[i + 2] < "0" || message[i + 2] > "9") continue;
    const prevDigit = i > 0 && message[i - 1] >= "0" && message[i - 1] <= "9";
    const nextDigit = i + 3 < message.length && message[i + 3] >= "0" && message[i + 3] <= "9";
    if (prevDigit || nextDigit) continue;
    const code = Number.parseInt(message.slice(i, i + 3), 10);
    if (code >= 400 && code < 600) return code;
  }
  return 401;
}

type HealthRow = {
  id: string;
  consecutiveErrors: number;
  status: string;
  unhealthyCountUpdatedAt: Date | null;
  lastErrorAt: Date | null;
  lastSuccessAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  lastErrorCode: number | null;
};

function latestHealthRequestAt(row: HealthRow): Date | null {
  let latest: Date | null = row.unhealthyCountUpdatedAt;
  if (row.lastErrorAt && (!latest || row.lastErrorAt.getTime() > latest.getTime())) latest = row.lastErrorAt;
  if (row.lastSuccessAt && (!latest || row.lastSuccessAt.getTime() > latest.getTime())) latest = row.lastSuccessAt;
  if (!latest && row.updatedAt) latest = row.updatedAt;
  if (!latest && row.createdAt) latest = row.createdAt;
  return latest;
}

function effectiveUnhealthyCount(row: HealthRow, now: Date): number {
  const count = row.consecutiveErrors;
  if (count <= 0) return 0;
  const lastRequestAt = latestHealthRequestAt(row);
  if (!lastRequestAt || lastRequestAt.getTime() > now.getTime()) return count;
  const decay = Math.trunc((now.getTime() - lastRequestAt.getTime()) / UNHEALTHY_IDLE_DECAY_MS);
  if (decay <= 0) return count;
  if (decay >= count) return 0;
  return count - decay;
}

function modelHealthStatus(unhealthyCount: number): string {
  return unhealthyCount >= MODEL_DEGRADED_THRESHOLD ? "degraded" : "active";
}

function cooldownRecoveryCount(unhealthyCount: number): number {
  if (unhealthyCount <= 0) return 0;
  const reduction = Math.round(unhealthyCount * COOLDOWN_RECOVERY_RATIO);
  if (reduction > unhealthyCount) return 0;
  return unhealthyCount - reduction;
}

function isImmediatelyRecoverableStatusCode(code: number): boolean {
  return code === 408 || code === 429 || code >= 500;
}

function successRecoveryCount(row: HealthRow, now: Date): number {
  let count = effectiveUnhealthyCount(row, now);
  if (row.lastErrorCode !== null && !isImmediatelyRecoverableStatusCode(row.lastErrorCode)) return count;
  if (count > 0) count -= 1;
  return count;
}

function sortAccountsByProviderPriority(accounts: ProviderAccount[], priority: string[]): void {
  const order = new Map<string, number>();
  priority.forEach((provider, index) => order.set(provider, index));
  accounts.sort((a, b) => {
    const ai = order.get(a.provider) ?? 1 << 30;
    const aj = order.get(b.provider) ?? 1 << 30;
    if (ai !== aj) return ai - aj;
    if ((a.status ?? "") !== (b.status ?? "")) return (a.status ?? "") < (b.status ?? "") ? -1 : 1;
    return nullableTimeBefore(a.lastUsedAt, b.lastUsedAt) ? -1 : 0;
  });
}

function prioritizeAccounts(accounts: ProviderAccount[], groupByProvider: boolean, priority: string[]): ProviderAccount[] {
  if (!groupByProvider) return paidFirst(accounts);
  const byProvider = new Map<string, ProviderAccount[]>();
  for (const account of accounts) {
    const list = byProvider.get(account.provider) ?? [];
    list.push(account);
    byProvider.set(account.provider, list);
  }
  const result: ProviderAccount[] = [];
  for (const provider of priority) result.push(...paidFirst(byProvider.get(provider) ?? []));
  return result;
}

function paidFirst(accounts: ProviderAccount[]): ProviderAccount[] {
  const paid: ProviderAccount[] = [];
  const free: ProviderAccount[] = [];
  for (const account of accounts) {
    if (isSyntheticProviderAccountId(account.id)) free.push(account);
    else if (isPaidAccountTier(account.provider, account.tier ?? null)) paid.push(account);
    else free.push(account);
  }
  return [...paid, ...free];
}

function isPaidAccountTier(provider: string, tier: string | null): boolean {
  if (!tier) return false;
  const value = tier.trim().toLowerCase();
  switch (provider) {
    case "antigravity":
      return value === "paid" || value === "standard-tier" || value.startsWith("g1-");
    case "kiro":
      return value === "pro" || value === "pro+" || value === "pro-plus" || value === "power";
    default:
      break;
  }
  const paid = new Set([
    "paid", "standard-tier", "plus", "pro", "pro-plus", "pro+", "prolite", "power", "team", "go",
    "self_serve_business_usage_based", "business", "enterprise_cbp_usage_based", "enterprise", "edu",
    "education", "hc",
  ]);
  return paid.has(value);
}

function nullableTimeBefore(a: Date | null | undefined, b: Date | null | undefined): boolean {
  if (!a && !b) return false;
  if (!a) return true;
  if (!b) return false;
  return a.getTime() < b.getTime();
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("upstream request timed out")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function normalizeAccountTierAlias(tier: string): string {
  const normalized = tier.trim().toLowerCase().replace(/_/g, "-");
  if (normalized === "pro-plus" || normalized === "proplus") return "pro+";
  if (normalized === "free-tier") return "free";
  if (["education", "educational", "edu", "free-educational-quota"].includes(normalized)) return "student";
  return normalized;
}

function proxyTierSatisfiesRule(tier: string, minTier: string | undefined, allowedTiers: string[] | undefined): boolean {
  const normalized = normalizeAccountTierAlias(tier);
  if (allowedTiers && allowedTiers.length > 0) {
    return allowedTiers.some((value) => normalizeAccountTierAlias(value) === normalized);
  }
  const required = (minTier ?? "").trim().toLowerCase();
  if (!required || required === "free") return true;
  return normalized === normalizeAccountTierAlias(required);
}

function proxyAccessRuleRestrictsTier(minTier: string | undefined, allowedTiers: string[] | undefined): boolean {
  if (allowedTiers && allowedTiers.length > 0) return true;
  const required = normalizeAccountTierAlias(minTier ?? "");
  return required !== "" && required !== "free";
}

function quotaFallbackTierLocal(account: ProviderAccount): string {
  const tier = account.tier?.trim();
  return tier ? tier : "free";
}

export function extractSessionId(request: Request, body: Record<string, unknown>): string {
  for (const header of [
    "x-claude-code-session-id",
    "session_id",
    "x-session-id",
    "session-id",
    "x-session-affinity",
    "x-client-request-id",
  ]) {
    const value = request.headers.get(header)?.trim();
    if (value) return value;
  }
  for (const key of ["prompt_cache_key", "session_id", "sessionId", "conversation_id"]) {
    const value = body[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const metadata = body.metadata;
  if (metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)) {
    const userId = (metadata as Record<string, unknown>).user_id;
    if (typeof userId === "string" && userId.trim()) {
      const match = /_session_([a-f0-9-]+)$/.exec(userId);
      if (match) return `claude:${match[1]}`;
      return userId.trim();
    }
  }
  const text = firstUserText(body);
  if (text && text.trim().length > 20) {
    const trimmed = text.trim().slice(0, 100);
    return `prompt:${createHash("sha256").update(trimmed).digest("hex").slice(0, 16)}`;
  }
  return "";
}

function firstUserText(body: Record<string, unknown>): string {
  const messages = body.messages;
  if (Array.isArray(messages)) {
    for (const raw of messages) {
      const msg = (raw ?? {}) as Record<string, unknown>;
      if (msg.role !== "user") continue;
      const text = sessionTextContent(msg.content);
      if (text) return text;
    }
  }
  const input = body.input;
  if (Array.isArray(input)) {
    for (const raw of input) {
      const item = (raw ?? {}) as Record<string, unknown>;
      if (item.role !== "user") continue;
      const text = sessionTextContent(item.content);
      if (text) return text;
    }
  }
  return "";
}

function sessionTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const raw of content) {
    const part = (raw ?? {}) as Record<string, unknown>;
    const text = stringValue(part.text).trim();
    if (text) texts.push(text);
  }
  return texts.join("\n");
}

export { cloneMap, numberAsInt, creditSharingPoint, adjustRoamingPoints, roamingPoints };
