import { Effect } from "effect";
import type { UsagePort } from "./repositories.js";
import type { AuthResult, AuthService, ModelValidationResult } from "@opendum/auth";
import type { OpendumRedis } from "@opendum/core/redis";
import type { Registry } from "@opendum/models/runtime";
import type { ProviderAccount } from "@opendum/providers";
import type { Health } from "./health.js";
import type { ProviderPerformance } from "./provider-performance.js";
import { ignore, isSyntheticProviderAccountId } from "./service-helpers.js";
import type { StreamRecorder, SuccessRecord } from "./types.js";

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
};

/**
 * Records every terminal outcome of a proxy attempt: success feeds account
 * health and provider performance, failures only write usage logs. Also owns
 * the Hypercredits balance snapshot kept in Redis.
 */
export class Usage implements StreamRecorder {
  private readonly usage: UsagePort;
  private readonly redis: OpendumRedis;
  private readonly auth: AuthService;
  private readonly models: Registry;
  private readonly performance: ProviderPerformance;
  private readonly health: Health;

  constructor(options: Options) {
    this.usage = options.usage;
    this.redis = options.redis;
    this.auth = options.auth;
    this.models = options.models;
    this.performance = options.performance;
    this.health = options.health;
  }

  storeCredits(accountId: string, remaining: number | null, cost: number): void {
    if (!accountId) return;
    void Effect.runFork(
      ignore(async () => {
        const key = BALANCE_PREFIX + accountId;
        if (remaining !== null && remaining > 0) {
          await this.redis.set(key, String(remaining), { EX: BALANCE_TTL });
          return;
        }
        if (cost > 0) {
          const raw = await this.redis.get(key);
          const current = raw === null ? Number.NaN : Number(raw);
          if (Number.isFinite(current) && current > 0) {
            const next = Math.max(0, current - cost);
            await this.redis.set(key, String(next), { EX: BALANCE_TTL });
          }
        }
      })
    );
  }

  recordSuccess(params: SuccessRecord): void {
    void Effect.runFork(
      ignore(async () => {
        await this.health.markAccountSuccess(params.accountId, params.model);
        await this.performance.record({
          provider: params.provider,
          model: this.models.resolveAlias(params.model),
          ttftMs: params.upstreamFirstResponseMs > params.requestStartMs ? params.upstreamFirstResponseMs - params.requestStartMs : 0,
          outputTokens: params.outputTokens,
          durationMs: params.durationMs,
        });
        await this.logRaw({
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
      })
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

  async logRaw(params: UsageLog): Promise<void> {
    if (!params.userId || !params.model) return;
    const providerAccountId = params.providerAccountId && !isSyntheticProviderAccountId(params.providerAccountId)
      ? params.providerAccountId
      : null;
    await this.usage.insertUsageLog({
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
    await Effect.runPromise(this.auth.bumpVersion(params.userId));
  }
}
