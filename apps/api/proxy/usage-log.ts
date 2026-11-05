import { Effect } from "effect";
import type { DatabaseFailure } from "@opendum/database";
import type { UsagePort } from "@opendum/api/proxy/repositories";
import type { AuthResult, AuthService, ModelValidationResult } from "@opendum/auth";
import type { OpendumRedis } from "@opendum/platform/redis";
import type { Registry } from "@opendum/models/runtime";
import type { ProviderAccount } from "@opendum/providers";
import type { Health } from "@opendum/api/proxy/health";
import type { ProviderPerformance } from "@opendum/api/proxy/provider-performance";
import type { ProxyEvents } from "@opendum/api/proxy/events";
import { isSynthetic } from "@opendum/api/proxy/service-helpers";
import { trackWork } from "@opendum/api/proxy/pending";
import type { StreamRecorder, SuccessRecord } from "@opendum/api/proxy/types";

const BALANCE_PREFIX = "opendum:hypercredits:balance:";
const BALANCE_TTL = 30 * 24 * 60 * 60;

export type UsageLog = {
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
};

export type Options = {
  usage: UsagePort;
  redis: OpendumRedis;
  auth: AuthService;
  models: Registry;
  performance: ProviderPerformance;
  health: Health;
  events?: ProxyEvents;
};

export class Usage implements StreamRecorder {
  private readonly usage: UsagePort;
  private readonly redis: OpendumRedis;
  private readonly auth: AuthService;
  private readonly models: Registry;
  private readonly performance: ProviderPerformance;
  private readonly health: Health;
  private readonly events?: ProxyEvents;

  constructor(options: Options) {
    this.usage = options.usage;
    this.redis = options.redis;
    this.auth = options.auth;
    this.models = options.models;
    this.performance = options.performance;
    this.health = options.health;
    this.events = options.events;
  }

  storeCredits(accountId: string, remaining: number | null, cost: number): void {
    if (!accountId) return;
    trackWork(this.writeCredits(accountId, remaining, cost));
  }

  private writeCredits(accountId: string, remaining: number | null, cost: number): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const key = BALANCE_PREFIX + accountId;
      if (remaining !== null && remaining > 0) {
        yield* this.redisEffect(() => this.redis.set(key, String(remaining), { EX: BALANCE_TTL }));
        return;
      }
      if (cost <= 0) return;
      const raw = yield* this.redisEffect(() => this.redis.get(key));
      const current = raw === null ? Number.NaN : Number(raw);
      if (!Number.isFinite(current) || current <= 0) return;
      yield* this.redisEffect(() => this.redis.set(key, String(Math.max(0, current - cost)), { EX: BALANCE_TTL }));
    }).pipe(Effect.ignore);
  }

  recordSuccess(params: SuccessRecord): void {
    trackWork(
      Effect.gen({ self: this }, function* () {
        yield* this.health.markAccountSuccess(params.accountId, params.model).pipe(Effect.ignore);
        yield* this.performance.record({
          provider: params.provider,
          model: this.models.resolveAlias(params.model),
          ttftMs:
            params.firstResponseMs > params.requestStartMs
              ? params.firstResponseMs - params.requestStartMs
              : 0,
          outputTokens: params.outputTokens,
          durationMs: params.durationMs,
        });
        yield* this.writeUsageLog({
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
      }).pipe(Effect.ignore)
    );
  }

  async logUsage(
    authResult: AuthResult,
    account: ProviderAccount,
    validation: ModelValidationResult,
    statusCode: number,
    durationMs: number
  ): Promise<void> {
    await this.logRaw({
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

  logRaw(params: UsageLog): Promise<void> {
    return Effect.runPromise(this.writeUsageLog(params).pipe(Effect.ignore));
  }

  private writeUsageLog(params: UsageLog): Effect.Effect<void, DatabaseFailure> {
    if (!params.userId || !params.model) return Effect.void;
    const providerAccountId =
      params.providerAccountId && !isSynthetic(params.providerAccountId)
        ? params.providerAccountId
        : null;
    return Effect.gen({ self: this }, function* () {
      yield* this.usage.insertUsageLog({
          id: crypto.randomUUID(),
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
        });
      this.events?.publishUsageLogged(params.userId);
      yield* this.auth.bumpVersion(params.userId);
    });
  }

  private redisEffect<A>(run: () => Promise<A>): Effect.Effect<A, Error> {
    return Effect.tryPromise({
      try: run,
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    });
  }
}
