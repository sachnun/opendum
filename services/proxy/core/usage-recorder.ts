import { Effect } from "effect";
import type { UsagePort } from "./repositories.js";
import type { AuthResult, AuthService, ModelValidationResult } from "@opendum/auth";
import type { OpendumRedis } from "@opendum/core/redis";
import type { Registry } from "@opendum/models/runtime";
import type { ProviderAccount } from "@opendum/providers";
import type { AccountHealthService } from "./account-health.js";
import type { ProviderPerformance } from "./provider-performance.js";
import { ignoringErrors, isSyntheticProviderAccountId } from "./service-helpers.js";
import type { StreamRecorder, SuccessfulRequestRecord } from "./types.js";

const HYPERCREDITS_BALANCE_PREFIX = "opendum:hypercredits:balance:";
const HYPERCREDITS_BALANCE_TTL_SECONDS = 30 * 24 * 60 * 60;

export type UsageLogRecord = {
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

export type UsageRecorderOptions = {
  usage: UsagePort;
  redis: OpendumRedis;
  auth: AuthService;
  models: Registry;
  performance: ProviderPerformance;
  health: AccountHealthService;
};

/**
 * Records every terminal outcome of a proxy attempt: success feeds account
 * health and provider performance, failures only write usage logs. Also owns
 * the Hypercredits balance snapshot kept in Redis.
 */
export class UsageRecorder implements StreamRecorder {
  private readonly usage: UsagePort;
  private readonly redis: OpendumRedis;
  private readonly auth: AuthService;
  private readonly models: Registry;
  private readonly performance: ProviderPerformance;
  private readonly health: AccountHealthService;

  constructor(options: UsageRecorderOptions) {
    this.usage = options.usage;
    this.redis = options.redis;
    this.auth = options.auth;
    this.models = options.models;
    this.performance = options.performance;
    this.health = options.health;
  }

  storeHypercreditsUsage(accountId: string, remaining: number | null, cost: number): void {
    if (!accountId) return;
    void Effect.runFork(
      ignoringErrors(async () => {
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
      })
    );
  }

  recordSuccessfulRequest(params: SuccessfulRequestRecord): void {
    void Effect.runFork(
      ignoringErrors(async () => {
        await this.health.markAccountSuccess(params.accountId, params.model);
        await this.performance.record({
          provider: params.provider,
          model: this.models.resolveAlias(params.model),
          ttftMs: params.upstreamFirstResponseMs > params.requestStartMs ? params.upstreamFirstResponseMs - params.requestStartMs : 0,
          outputTokens: params.outputTokens,
          durationMs: params.durationMs,
        });
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

  async logUsageRaw(params: UsageLogRecord): Promise<void> {
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
    await this.auth.bumpAnalyticsCacheVersionThrottled(params.userId);
  }
}
