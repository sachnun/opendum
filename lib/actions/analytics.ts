"use server";

import { Effect } from "effect";
import { proxyApiKey, usageLog } from "@/lib/db/schema";
import { eq, and, gte, lte, sql } from "drizzle-orm";
import { buildAnalyticsCacheKey } from "@/lib/cache/analytics-cache";
import { DatabaseService, RedisService, requireUserId } from "@/lib/effect/services";
import { DatabaseError, NotFoundError, RedisError, ValidationError } from "@/lib/effect/errors";
import { runServerAction, MainLayer, type ActionResult } from "@/lib/effect/runtime";

export type Period = "5m" | "15m" | "30m" | "1h" | "6h" | "24h" | "7d" | "30d" | "90d";

export interface CustomDateRange {
  from: string;
  to: string;
}

export type AnalyticsFilter = Period | CustomDateRange;

// Granularity determines how data points are grouped
export type Granularity = "10s" | "1m" | "5m" | "15m" | "1h" | "1d";

export interface PeriodConfig {
  duration: number; // in milliseconds
  granularity: Granularity;
  granularityMs: number; // granularity in milliseconds
}

const PERIOD_CONFIG: Record<Period, PeriodConfig> = {
  "5m": { duration: 5 * 60 * 1000, granularity: "10s", granularityMs: 10 * 1000 },
  "15m": { duration: 15 * 60 * 1000, granularity: "1m", granularityMs: 60 * 1000 },
  "30m": { duration: 30 * 60 * 1000, granularity: "1m", granularityMs: 60 * 1000 },
  "1h": { duration: 60 * 60 * 1000, granularity: "5m", granularityMs: 5 * 60 * 1000 },
  "6h": { duration: 6 * 60 * 60 * 1000, granularity: "15m", granularityMs: 15 * 60 * 1000 },
  "24h": { duration: 24 * 60 * 60 * 1000, granularity: "1h", granularityMs: 60 * 60 * 1000 },
  "7d": { duration: 7 * 24 * 60 * 60 * 1000, granularity: "1d", granularityMs: 24 * 60 * 60 * 1000 },
  "30d": { duration: 30 * 24 * 60 * 60 * 1000, granularity: "1d", granularityMs: 24 * 60 * 60 * 1000 },
  "90d": { duration: 90 * 24 * 60 * 60 * 1000, granularity: "1d", granularityMs: 24 * 60 * 60 * 1000 },
};

interface GetAnalyticsOptions {
  forceRefresh?: boolean;
}

function getAnalyticsCacheTtlSeconds(durationMs: number): number {
  if (durationMs <= 60 * 60 * 1000) {
    return 15;
  }

  if (durationMs <= 24 * 60 * 60 * 1000) {
    return 45;
  }

  if (durationMs <= 7 * 24 * 60 * 60 * 1000) {
    return 120;
  }

  return 300;
}

export { type ActionResult };

export interface RequestsOverTimeData {
  date: string;
  count: number;
}

export interface TokenUsageData {
  date: string;
  input: number;
  output: number;
}

export interface RequestsByModelData {
  model: string;
  count: number;
}

export interface ModelDistributionData {
  model: string;
  value: number;
  percentage: number;
}

export interface SuccessRateData {
  date: string;
  success: number;
  error: number;
}

export interface DurationOverTimeData {
  date: string;
  avg: number | null;
  p30: number | null;
  p50: number | null;
  p60: number | null;
  p75: number | null;
  p90: number | null;
  p95: number | null;
  p99: number | null;
}

export interface DurationPercentiles {
  p30: number;
  p50: number;
  p60: number;
  p75: number;
  p90: number;
  p95: number;
  p99: number;
}

export interface AnalyticsTotals {
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  avgDuration: number;
  durationPercentiles: DurationPercentiles;
  successRate: number;
}

export interface AnalyticsData {
  requestsOverTime: RequestsOverTimeData[];
  tokenUsage: TokenUsageData[];
  requestsByModel: RequestsByModelData[];
  modelDistribution: ModelDistributionData[];
  successRate: SuccessRateData[];
  durationOverTime: DurationOverTimeData[];
  granularity: Granularity;
  totals: AnalyticsTotals;
}

function getStartDate(period: Period): Date {
  const config = PERIOD_CONFIG[period];
  return new Date(Date.now() - config.duration);
}

function getPeriodConfig(period: Period): PeriodConfig {
  return PERIOD_CONFIG[period];
}

function getCustomRangeConfig(startDate: Date, endDate: Date): PeriodConfig {
  const duration = Math.max(endDate.getTime() - startDate.getTime(), 0);

  if (duration <= PERIOD_CONFIG["5m"].duration) {
    return { ...PERIOD_CONFIG["5m"], duration };
  }

  if (duration <= PERIOD_CONFIG["30m"].duration) {
    return { ...PERIOD_CONFIG["30m"], duration };
  }

  if (duration <= PERIOD_CONFIG["1h"].duration) {
    return { ...PERIOD_CONFIG["1h"], duration };
  }

  if (duration <= PERIOD_CONFIG["6h"].duration) {
    return { ...PERIOD_CONFIG["6h"], duration };
  }

  if (duration <= PERIOD_CONFIG["24h"].duration) {
    return { ...PERIOD_CONFIG["24h"], duration };
  }

  return { ...PERIOD_CONFIG["7d"], duration };
}

function resolveFilterConfig(
  filter: AnalyticsFilter
): ActionResult<{ startDate: Date; endDate: Date; config: PeriodConfig }> {
  if (typeof filter === "string") {
    return {
      success: true,
      data: {
        startDate: getStartDate(filter),
        endDate: new Date(),
        config: getPeriodConfig(filter),
      },
    };
  }

  const fromDate = new Date(filter.from);
  const toDate = new Date(filter.to);

  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    return { success: false, error: "Invalid custom date range" };
  }

  const startDate = fromDate <= toDate ? fromDate : toDate;
  const endDate = toDate >= fromDate ? toDate : fromDate;

  return {
    success: true,
    data: {
      startDate,
      endDate,
      config: getCustomRangeConfig(startDate, endDate),
    },
  };
}

// Format time slot key based on granularity
function formatTimeSlot(date: Date, granularity: Granularity): string {
  switch (granularity) {
    case "10s": {
      // Round to nearest 10 seconds
      const seconds = Math.floor(date.getSeconds() / 10) * 10;
      const d = new Date(date);
      d.setSeconds(seconds, 0);
      return d.toISOString();
    }
    case "1m": {
      // Round to minute
      const d = new Date(date);
      d.setSeconds(0, 0);
      return d.toISOString();
    }
    case "5m": {
      // Round to 5 minutes
      const minutes = Math.floor(date.getMinutes() / 5) * 5;
      const d = new Date(date);
      d.setMinutes(minutes, 0, 0);
      return d.toISOString();
    }
    case "15m": {
      // Round to 15 minutes
      const minutes = Math.floor(date.getMinutes() / 15) * 15;
      const d = new Date(date);
      d.setMinutes(minutes, 0, 0);
      return d.toISOString();
    }
    case "1h": {
      // Round to hour
      const d = new Date(date);
      d.setMinutes(0, 0, 0);
      return d.toISOString();
    }
    case "1d": {
      // Round to day (date only)
      return date.toISOString().split("T")[0];
    }
  }
}

// Generate all time slots in range
function generateTimeSlots(startDate: Date, endDate: Date, config: PeriodConfig): string[] {
  const slots: string[] = [];
  const current = new Date(startDate);
  
  // Align start to granularity boundary
  if (config.granularity === "1d") {
    current.setHours(0, 0, 0, 0);
  } else if (config.granularity === "1h") {
    current.setMinutes(0, 0, 0);
  } else if (config.granularity === "15m") {
    current.setMinutes(Math.floor(current.getMinutes() / 15) * 15, 0, 0);
  } else if (config.granularity === "5m") {
    current.setMinutes(Math.floor(current.getMinutes() / 5) * 5, 0, 0);
  } else if (config.granularity === "1m") {
    current.setSeconds(0, 0);
  } else if (config.granularity === "10s") {
    current.setSeconds(Math.floor(current.getSeconds() / 10) * 10, 0);
  }
  
  while (current <= endDate) {
    slots.push(formatTimeSlot(current, config.granularity));
    current.setTime(current.getTime() + config.granularityMs);
  }
  
  return slots;
}

function getGranularityBucketSeconds(granularity: Granularity): number {
  switch (granularity) {
    case "10s":
      return 10;
    case "1m":
      return 60;
    case "5m":
      return 5 * 60;
    case "15m":
      return 15 * 60;
    case "1h":
      return 60 * 60;
    case "1d":
      return 24 * 60 * 60;
  }
}

function getTimeBucketExpression(granularity: Granularity) {
  const bucketSeconds = getGranularityBucketSeconds(granularity);
  const bucketSecondsLiteral = sql.raw(String(bucketSeconds));
  return sql<Date>`to_timestamp(floor(extract(epoch from ${usageLog.createdAt}) / ${bucketSecondsLiteral}) * ${bucketSecondsLiteral})`;
}

function toNumericValue(value: number | string | null | undefined): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function toRoundedValue(value: number | string | null | undefined): number {
  return Math.round(toNumericValue(value));
}

function toRoundedNullableValue(
  value: number | string | null | undefined
): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string" && value.length === 0) {
    return null;
  }

  return Math.round(toNumericValue(value));
}

function toDateValue(value: Date | string | null): Date | null {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// ---------------------------------------------------------------------------
// Effect-based Redis helpers (fail-open: return null / void on RedisError)
// ---------------------------------------------------------------------------

const getAnalyticsCacheVersionEffect = (userId: string) =>
  Effect.gen(function* () {
    const redis = yield* RedisService;
    const rawVersion = yield* Effect.tryPromise({
      try: () => redis.get(`opendum:analytics:v1:version:${userId}`),
      catch: (cause) => new RedisError({ cause }),
    });

    if (!rawVersion) {
      return 0;
    }

    const parsed = Number.parseInt(rawVersion, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  }).pipe(Effect.catchTag("RedisError", () => Effect.succeed(0)));

const getRedisJsonEffect = <T>(key: string) =>
  Effect.gen(function* () {
    const redis = yield* RedisService;
    const rawValue = yield* Effect.tryPromise({
      try: () => redis.get(key),
      catch: (cause) => new RedisError({ cause }),
    });

    if (!rawValue) {
      return null as T | null;
    }

    try {
      return JSON.parse(rawValue) as T;
    } catch {
      return null as T | null;
    }
  }).pipe(Effect.catchTag("RedisError", () => Effect.succeed(null as T | null)));

const setRedisJsonEffect = (key: string, value: unknown, ttlSeconds: number) =>
  Effect.gen(function* () {
    const redis = yield* RedisService;
    yield* Effect.tryPromise({
      try: () =>
        redis.set(key, JSON.stringify(value), "EX", Math.max(1, Math.floor(ttlSeconds))),
      catch: (cause) => new RedisError({ cause }),
    });
  }).pipe(Effect.catchTag("RedisError", () => Effect.void));

// ---------------------------------------------------------------------------
// Main analytics server action — Effect-based internally
// ---------------------------------------------------------------------------

export async function getAnalyticsData(
  filter: AnalyticsFilter,
  apiKeyId?: string,
  options: GetAnalyticsOptions = {}
): Promise<ActionResult<AnalyticsData>> {
  return runServerAction(
    Effect.gen(function* () {
      const userId = yield* requireUserId;
      const db = yield* DatabaseService;

      const resolvedFilter = resolveFilterConfig(filter);

      if (!resolvedFilter.success) {
        return yield* new ValidationError({ message: resolvedFilter.error });
      }

      const { startDate, endDate, config } = resolvedFilter.data;

      // Verify API key ownership if provided
      if (apiKeyId) {
        const [ownedApiKey] = yield* Effect.tryPromise({
          try: () =>
            db
              .select({ id: proxyApiKey.id })
              .from(proxyApiKey)
              .where(and(eq(proxyApiKey.id, apiKeyId), eq(proxyApiKey.userId, userId)))
              .limit(1),
          catch: (cause) => new DatabaseError({ cause }),
        });

        if (!ownedApiKey) {
          return yield* new NotFoundError({ message: "API key not found" });
        }
      }

      // Get cache version (fail-open: defaults to 0)
      const analyticsCacheVersion = yield* getAnalyticsCacheVersionEffect(userId);

      const cacheKey = buildAnalyticsCacheKey({
        userId,
        apiKeyId,
        startDateMs: startDate.getTime(),
        endDateMs: endDate.getTime(),
        granularity: config.granularity,
        version: analyticsCacheVersion,
      });

      // Check cache (fail-open: returns null)
      if (!options.forceRefresh) {
        const cachedAnalytics = yield* getRedisJsonEffect<AnalyticsData>(cacheKey);
        if (cachedAnalytics) {
          return cachedAnalytics;
        }
      }

      // Build query conditions
      const conditions = [
        eq(usageLog.userId, userId),
        gte(usageLog.createdAt, startDate),
        lte(usageLog.createdAt, endDate),
      ];

      if (apiKeyId) {
        conditions.push(eq(usageLog.proxyApiKeyId, apiKeyId));
      }

      const whereCondition = and(...conditions);
      const bucketExpression = getTimeBucketExpression(config.granularity);
      const normalizedModelExpression = sql<string>`replace(${usageLog.model}, 'iflow/', '')`;

      // Run all three queries in parallel
      const [timeSeriesRows, topModelRows, totalsRow] = yield* Effect.tryPromise({
        try: () =>
          Promise.all([
            db
              .select({
                bucket: bucketExpression,
                requestCount: sql<number>`count(*)`,
                inputTokens: sql<number>`coalesce(sum(${usageLog.inputTokens}), 0)`,
                outputTokens: sql<number>`coalesce(sum(${usageLog.outputTokens}), 0)`,
                successCount: sql<number>`count(*) filter (where ${usageLog.statusCode} >= 200 and ${usageLog.statusCode} < 400)`,
                errorCount: sql<number>`count(*) filter (where ${usageLog.statusCode} is null or ${usageLog.statusCode} < 200 or ${usageLog.statusCode} >= 400)`,
                avgDuration: sql<number | null>`avg(${usageLog.duration}) filter (where ${usageLog.duration} is not null)`,
                p30: sql<number | null>`percentile_cont(0.30) within group (order by ${usageLog.duration}) filter (where ${usageLog.duration} is not null)`,
                p50: sql<number | null>`percentile_cont(0.50) within group (order by ${usageLog.duration}) filter (where ${usageLog.duration} is not null)`,
                p60: sql<number | null>`percentile_cont(0.60) within group (order by ${usageLog.duration}) filter (where ${usageLog.duration} is not null)`,
                p75: sql<number | null>`percentile_cont(0.75) within group (order by ${usageLog.duration}) filter (where ${usageLog.duration} is not null)`,
                p90: sql<number | null>`percentile_cont(0.90) within group (order by ${usageLog.duration}) filter (where ${usageLog.duration} is not null)`,
                p95: sql<number | null>`percentile_cont(0.95) within group (order by ${usageLog.duration}) filter (where ${usageLog.duration} is not null)`,
                p99: sql<number | null>`percentile_cont(0.99) within group (order by ${usageLog.duration}) filter (where ${usageLog.duration} is not null)`,
              })
              .from(usageLog)
              .where(whereCondition)
              .groupBy(bucketExpression)
              .orderBy(bucketExpression),
            db
              .select({
                model: normalizedModelExpression,
                count: sql<number>`count(*)`,
              })
              .from(usageLog)
              .where(whereCondition)
              .groupBy(normalizedModelExpression)
              .orderBy(sql`count(*) desc`)
              .limit(10),
            db
              .select({
                totalRequests: sql<number>`count(*)`,
                totalInputTokens: sql<number>`coalesce(sum(${usageLog.inputTokens}), 0)`,
                totalOutputTokens: sql<number>`coalesce(sum(${usageLog.outputTokens}), 0)`,
                avgDuration: sql<number | null>`avg(${usageLog.duration}) filter (where ${usageLog.duration} is not null)`,
                p30: sql<number | null>`percentile_cont(0.30) within group (order by ${usageLog.duration}) filter (where ${usageLog.duration} is not null)`,
                p50: sql<number | null>`percentile_cont(0.50) within group (order by ${usageLog.duration}) filter (where ${usageLog.duration} is not null)`,
                p60: sql<number | null>`percentile_cont(0.60) within group (order by ${usageLog.duration}) filter (where ${usageLog.duration} is not null)`,
                p75: sql<number | null>`percentile_cont(0.75) within group (order by ${usageLog.duration}) filter (where ${usageLog.duration} is not null)`,
                p90: sql<number | null>`percentile_cont(0.90) within group (order by ${usageLog.duration}) filter (where ${usageLog.duration} is not null)`,
                p95: sql<number | null>`percentile_cont(0.95) within group (order by ${usageLog.duration}) filter (where ${usageLog.duration} is not null)`,
                p99: sql<number | null>`percentile_cont(0.99) within group (order by ${usageLog.duration}) filter (where ${usageLog.duration} is not null)`,
                successfulRequests: sql<number>`count(*) filter (where ${usageLog.statusCode} >= 200 and ${usageLog.statusCode} < 400)`,
              })
              .from(usageLog)
              .where(whereCondition)
              .then((rows) => rows[0]),
          ]),
        catch: (cause) => new DatabaseError({ cause }),
      });

      // Generate time slots for filling gaps based on granularity
      const timeSlots = generateTimeSlots(startDate, endDate, config);

      const timeSeriesBySlot = new Map<
        string,
        {
          requestCount: number;
          inputTokens: number;
          outputTokens: number;
          successCount: number;
          errorCount: number;
          avgDuration: number | null;
          p30: number | null;
          p50: number | null;
          p60: number | null;
          p75: number | null;
          p90: number | null;
          p95: number | null;
          p99: number | null;
        }
      >();

      for (const row of timeSeriesRows) {
        const bucketDate = toDateValue(row.bucket);
        if (!bucketDate) {
          continue;
        }

        const slot = formatTimeSlot(bucketDate, config.granularity);
        timeSeriesBySlot.set(slot, {
          requestCount: toRoundedValue(row.requestCount),
          inputTokens: toRoundedValue(row.inputTokens),
          outputTokens: toRoundedValue(row.outputTokens),
          successCount: toRoundedValue(row.successCount),
          errorCount: toRoundedValue(row.errorCount),
          avgDuration: toRoundedNullableValue(row.avgDuration),
          p30: toRoundedNullableValue(row.p30),
          p50: toRoundedNullableValue(row.p50),
          p60: toRoundedNullableValue(row.p60),
          p75: toRoundedNullableValue(row.p75),
          p90: toRoundedNullableValue(row.p90),
          p95: toRoundedNullableValue(row.p95),
          p99: toRoundedNullableValue(row.p99),
        });
      }

      const requestsOverTime: RequestsOverTimeData[] = timeSlots.map((date) => ({
        date,
        count: timeSeriesBySlot.get(date)?.requestCount ?? 0,
      }));

      const tokenUsage: TokenUsageData[] = timeSlots.map((date) => ({
        date,
        input: timeSeriesBySlot.get(date)?.inputTokens ?? 0,
        output: timeSeriesBySlot.get(date)?.outputTokens ?? 0,
      }));

      const successRate: SuccessRateData[] = timeSlots.map((date) => ({
        date,
        success: timeSeriesBySlot.get(date)?.successCount ?? 0,
        error: timeSeriesBySlot.get(date)?.errorCount ?? 0,
      }));

      const durationOverTime: DurationOverTimeData[] = timeSlots.map((date) => {
        const entry = timeSeriesBySlot.get(date);
        return {
          date,
          avg: entry?.avgDuration ?? null,
          p30: entry?.p30 ?? null,
          p50: entry?.p50 ?? null,
          p60: entry?.p60 ?? null,
          p75: entry?.p75 ?? null,
          p90: entry?.p90 ?? null,
          p95: entry?.p95 ?? null,
          p99: entry?.p99 ?? null,
        };
      });

      const requestsByModel: RequestsByModelData[] = topModelRows.map((row) => ({
        model: row.model,
        count: toRoundedValue(row.count),
      }));

      const totalRequests = toRoundedValue(totalsRow?.totalRequests);
      const totalInputTokens = toRoundedValue(totalsRow?.totalInputTokens);
      const totalOutputTokens = toRoundedValue(totalsRow?.totalOutputTokens);
      const successfulRequests = toRoundedValue(totalsRow?.successfulRequests);
      const successRatePercent =
        totalRequests > 0 ? Math.round((successfulRequests / totalRequests) * 100) : 0;

      const durationPercentiles: DurationPercentiles = {
        p30: toRoundedValue(totalsRow?.p30),
        p50: toRoundedValue(totalsRow?.p50),
        p60: toRoundedValue(totalsRow?.p60),
        p75: toRoundedValue(totalsRow?.p75),
        p90: toRoundedValue(totalsRow?.p90),
        p95: toRoundedValue(totalsRow?.p95),
        p99: toRoundedValue(totalsRow?.p99),
      };

      const modelDistribution: ModelDistributionData[] = requestsByModel.map(({ model, count }) => ({
        model,
        value: count,
        percentage: totalRequests > 0 ? Math.round((count / totalRequests) * 100) : 0,
      }));

      const avgDuration = toRoundedNullableValue(totalsRow?.avgDuration) ?? 0;

      const totals: AnalyticsTotals = {
        totalRequests,
        totalInputTokens,
        totalOutputTokens,
        avgDuration,
        durationPercentiles,
        successRate: successRatePercent,
      };

      const analyticsData: AnalyticsData = {
        requestsOverTime,
        tokenUsage,
        requestsByModel,
        modelDistribution,
        successRate,
        durationOverTime,
        granularity: config.granularity,
        totals,
      };

      // Write to cache (fail-open: ignores Redis errors)
      yield* setRedisJsonEffect(
        cacheKey,
        analyticsData,
        getAnalyticsCacheTtlSeconds(config.duration)
      );

      return analyticsData;
    }),
    MainLayer
  );
}
