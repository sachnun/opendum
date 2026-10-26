import { Effect } from "effect";
import { db, providerAccount, proxyApiKey, usageLog } from "@opendum/database";
import { and, eq, gte, lte, sql } from "drizzle-orm";

import { fromPromise } from "@opendum/api/web/lib/task";
import { internal } from "@opendum/api/web/errors";

import type { AnalyticsDataInput, AnalyticsFilterInput, AnalyticsPeriod, AnalyticsSeriesInput, AnalyticsUsageInput } from "@opendum/providers/contract";

type Period = AnalyticsPeriod;
type AnalyticsFilter = AnalyticsFilterInput;
type Granularity = "10s" | "1m" | "5m" | "15m" | "1h" | "1d";

interface PeriodConfig {
  duration: number;
  granularity: Granularity;
  granularityMs: number;
}

interface AnalyticsData {
  requestsOverTime: Array<{ date: string; count: number }>;
  tokenUsage: Array<{ date: string; input: number; output: number; cache: number; cacheWrite: number }>;
  requestsByModel: Array<{ model: string; count: number }>;
  modelDistribution: Array<{ model: string; value: number; percentage: number }>;
  successRate: Array<{ date: string; success: number; error: number; successRate?: number; errorRate?: number }>;
  durationOverTime: Array<{ date: string; avg: number | null; p30: number | null; p50: number | null; p60: number | null; p75: number | null; p90: number | null; p95: number | null; p99: number | null }>;
  granularity: Granularity;
  totals: {
    totalRequests: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCachedTokens: number;
    totalCacheWriteTokens: number;
    avgDuration: number;
    durationPercentiles: { p30: number; p50: number; p60: number; p75: number; p90: number; p95: number; p99: number };
    successRate: number;
  };
}

interface AnalyticsSeriesData {
  requestsOverTime: AnalyticsData["requestsOverTime"];
  tokenUsage: AnalyticsData["tokenUsage"];
  successRate: AnalyticsData["successRate"];
  durationOverTime: AnalyticsData["durationOverTime"];
  granularity: AnalyticsData["granularity"];
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
const CUSTOM_RANGE_CONFIGS = [PERIOD_CONFIG["5m"], PERIOD_CONFIG["30m"], PERIOD_CONFIG["1h"], PERIOD_CONFIG["6h"], PERIOD_CONFIG["24h"], PERIOD_CONFIG["7d"]] as const;
const GRANULARITY_BUCKET_SECONDS: Record<Granularity, number> = { "10s": 10, "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "1d": 86400 };
const GRANULARITY_ROUNDERS: Record<Granularity, (date: Date) => string | undefined> = {
  "10s": (date) => { date.setSeconds(Math.floor(date.getSeconds() / 10) * 10, 0); return undefined; },
  "1m": (date) => { date.setSeconds(0, 0); return undefined; },
  "5m": (date) => { date.setMinutes(Math.floor(date.getMinutes() / 5) * 5, 0, 0); return undefined; },
  "15m": (date) => { date.setMinutes(Math.floor(date.getMinutes() / 15) * 15, 0, 0); return undefined; },
  "1h": (date) => { date.setMinutes(0, 0, 0); return undefined; },
  "1d": (date) => {
    date.setHours(0, 0, 0, 0);
    return date.toISOString().split("T")[0] ?? "";
  },
};

function filterConfig(
  filter: AnalyticsFilter
):
  | { success: true; data: { startDate: Date; endDate: Date; config: PeriodConfig } }
  | { success: false; error: string } {
  if (typeof filter === "string") {
    const config = PERIOD_CONFIG[filter];
    return { success: true, data: { startDate: new Date(Date.now() - config.duration), endDate: new Date(), config } };
  }

  const fromDate = new Date(filter.from);
  const toDate = new Date(filter.to);
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    return { success: false, error: "Invalid custom date range" };
  }

  const startDate = fromDate <= toDate ? fromDate : toDate;
  const endDate = toDate >= fromDate ? toDate : fromDate;
  const duration = Math.max(endDate.getTime() - startDate.getTime(), 0);
  const config = { ...(CUSTOM_RANGE_CONFIGS.find((entry) => duration <= entry.duration) ?? PERIOD_CONFIG["7d"]), duration };

  return { success: true, data: { startDate, endDate, config } };
}

function slotLabel(date: Date, granularity: Granularity): string {
  const d = new Date(date);
  return GRANULARITY_ROUNDERS[granularity](d) || d.toISOString();
}

function timeSlots(startDate: Date, endDate: Date, config: PeriodConfig): string[] {
  const slots: string[] = [];
  const current = new Date(startDate);
  GRANULARITY_ROUNDERS[config.granularity](current);
  while (current <= endDate) {
    slots.push(slotLabel(current, config.granularity));
    current.setTime(current.getTime() + config.granularityMs);
  }
  return slots;
}

function bucketSeconds(granularity: Granularity): number {
  return GRANULARITY_BUCKET_SECONDS[granularity];
}

function roundValue(value: number | string | null | undefined): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 0;
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}

function roundNullable(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  return roundValue(value);
}

function dateValue(value: Date | string | null): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const analyticsFor = Effect.fn("analytics.getDataForUser")(function* (
  userId: string,
  filter: AnalyticsFilter,
  apiKeyId?: string,
  options: { includeSummary?: boolean; includeSeries?: boolean } = {}
) {
  return yield* buildAnalyticsData(userId, filter, apiKeyId, options).pipe(
    Effect.catch(() =>
      Effect.succeed({ success: false as const, error: "Failed to fetch analytics data" })
    )
  );
});

const buildAnalyticsData = Effect.fnUntraced(function* (
  userId: string,
  filter: AnalyticsFilter,
  apiKeyId?: string,
  options: { includeSummary?: boolean; includeSeries?: boolean } = {}
) {
  const resolvedFilter = filterConfig(filter);
  if (!resolvedFilter.success) return resolvedFilter;

  const { startDate, endDate, config } = resolvedFilter.data;
  const includeSummary = options.includeSummary ?? true;
  const includeSeries = options.includeSeries ?? true;

  if (apiKeyId) {
    const ownedApiKey = yield* fromPromise(
      () =>
        db
          .select({ id: proxyApiKey.id })
          .from(proxyApiKey)
          .where(and(eq(proxyApiKey.id, apiKeyId), eq(proxyApiKey.userId, userId)))
          .limit(1),
      "Failed to fetch analytics data"
    );
    if (!ownedApiKey[0]) return { success: false as const, error: "API key not found" };
  }

    const conditions = [eq(usageLog.userId, userId), gte(usageLog.createdAt, startDate), lte(usageLog.createdAt, endDate)];
    if (apiKeyId) conditions.push(eq(usageLog.proxyApiKeyId, apiKeyId));
    const whereCondition = and(...conditions);
    const bucketSql = sql.raw(String(bucketSeconds(config.granularity)));
    const bucketExpression = sql<Date>`to_timestamp(floor(extract(epoch from ${usageLog.createdAt}) / ${bucketSql}) * ${bucketSql})`;

    const timeSeriesRows = includeSeries
      ? yield* fromPromise(
          () => db.select({ bucket: bucketExpression, requestCount: sql<number>`count(*)`, inputTokens: sql<number>`coalesce(sum(${usageLog.inputTokens}), 0)`, outputTokens: sql<number>`coalesce(sum(${usageLog.outputTokens}), 0)`, cachedTokens: sql<number>`coalesce(sum(${usageLog.cachedTokens}), 0)`, cacheWriteTokens: sql<number>`coalesce(sum(${usageLog.cacheWriteTokens}), 0)`, successCount: sql<number>`count(*) filter (where ${usageLog.statusCode} >= 200 and ${usageLog.statusCode} < 400)`, errorCount: sql<number>`count(*) filter (where ${usageLog.statusCode} is null or ${usageLog.statusCode} < 200 or ${usageLog.statusCode} >= 400)`, avgDuration: sql<number | null>`avg(${usageLog.duration}) filter (where ${usageLog.duration} is not null)`, p30: sql<number | null>`percentile_cont(0.30) within group (order by ${usageLog.duration}) filter (where ${usageLog.duration} is not null)`, p50: sql<number | null>`percentile_cont(0.50) within group (order by ${usageLog.duration}) filter (where ${usageLog.duration} is not null)`, p60: sql<number | null>`percentile_cont(0.60) within group (order by ${usageLog.duration}) filter (where ${usageLog.duration} is not null)`, p75: sql<number | null>`percentile_cont(0.75) within group (order by ${usageLog.duration}) filter (where ${usageLog.duration} is not null)`, p90: sql<number | null>`percentile_cont(0.90) within group (order by ${usageLog.duration}) filter (where ${usageLog.duration} is not null)`, p95: sql<number | null>`percentile_cont(0.95) within group (order by ${usageLog.duration}) filter (where ${usageLog.duration} is not null)`, p99: sql<number | null>`percentile_cont(0.99) within group (order by ${usageLog.duration}) filter (where ${usageLog.duration} is not null)` }).from(usageLog).where(whereCondition).groupBy(bucketExpression).orderBy(bucketExpression),
          "Failed to fetch analytics series"
        )
      : [];
    const topModelRows = includeSummary
      ? yield* fromPromise(
          () => db.select({ model: usageLog.model, count: sql<number>`count(*)` }).from(usageLog).where(whereCondition).groupBy(usageLog.model).orderBy(sql`count(*) desc`).limit(10),
          "Failed to fetch analytics models"
        )
      : [];
    const totalsRow = includeSummary
      ? yield* fromPromise(
          () => db.select({ totalRequests: sql<number>`count(*)`, totalInputTokens: sql<number>`coalesce(sum(${usageLog.inputTokens}), 0)`, totalOutputTokens: sql<number>`coalesce(sum(${usageLog.outputTokens}), 0)`, totalCachedTokens: sql<number>`coalesce(sum(${usageLog.cachedTokens}), 0)`, totalCacheWriteTokens: sql<number>`coalesce(sum(${usageLog.cacheWriteTokens}), 0)`, avgDuration: sql<number | null>`avg(${usageLog.duration}) filter (where ${usageLog.duration} is not null)`, p30: sql<number | null>`percentile_cont(0.30) within group (order by ${usageLog.duration}) filter (where ${usageLog.duration} is not null)`, p50: sql<number | null>`percentile_cont(0.50) within group (order by ${usageLog.duration}) filter (where ${usageLog.duration} is not null)`, p60: sql<number | null>`percentile_cont(0.60) within group (order by ${usageLog.duration}) filter (where ${usageLog.duration} is not null)`, p75: sql<number | null>`percentile_cont(0.75) within group (order by ${usageLog.duration}) filter (where ${usageLog.duration} is not null)`, p90: sql<number | null>`percentile_cont(0.90) within group (order by ${usageLog.duration}) filter (where ${usageLog.duration} is not null)`, p95: sql<number | null>`percentile_cont(0.95) within group (order by ${usageLog.duration}) filter (where ${usageLog.duration} is not null)`, p99: sql<number | null>`percentile_cont(0.99) within group (order by ${usageLog.duration}) filter (where ${usageLog.duration} is not null)`, successfulRequests: sql<number>`count(*) filter (where ${usageLog.statusCode} >= 200 and ${usageLog.statusCode} < 400)` }).from(usageLog).where(whereCondition).then((rows) => rows[0]),
          "Failed to fetch analytics totals"
        )
      : undefined;

    const seriesBySlot = new Map<string, { requestCount: number; inputTokens: number; outputTokens: number; cachedTokens: number; cacheWriteTokens: number; successCount: number; errorCount: number; avgDuration: number | null; p30: number | null; p50: number | null; p60: number | null; p75: number | null; p90: number | null; p95: number | null; p99: number | null }>();
    for (const row of timeSeriesRows) {
      const bucketDate = dateValue(row.bucket);
      if (!bucketDate) continue;
      seriesBySlot.set(slotLabel(bucketDate, config.granularity), { requestCount: roundValue(row.requestCount), inputTokens: roundValue(row.inputTokens), outputTokens: roundValue(row.outputTokens), cachedTokens: roundValue(row.cachedTokens), cacheWriteTokens: roundValue(row.cacheWriteTokens), successCount: roundValue(row.successCount), errorCount: roundValue(row.errorCount), avgDuration: roundNullable(row.avgDuration), p30: roundNullable(row.p30), p50: roundNullable(row.p50), p60: roundNullable(row.p60), p75: roundNullable(row.p75), p90: roundNullable(row.p90), p95: roundNullable(row.p95), p99: roundNullable(row.p99) });
    }

    const slots = includeSeries ? timeSlots(startDate, endDate, config) : [];
    const requestsByModel = includeSummary ? topModelRows.map((row) => ({ model: row.model, count: roundValue(row.count) })) : [];
    const totalRequests = roundValue(totalsRow?.totalRequests);
    const successfulRequests = roundValue(totalsRow?.successfulRequests);
    const analyticsData: AnalyticsData = {
      requestsOverTime: slots.map((date) => ({ date, count: seriesBySlot.get(date)?.requestCount ?? 0 })),
      tokenUsage: slots.map((date) => ({ date, input: seriesBySlot.get(date)?.inputTokens ?? 0, output: seriesBySlot.get(date)?.outputTokens ?? 0, cache: seriesBySlot.get(date)?.cachedTokens ?? 0, cacheWrite: seriesBySlot.get(date)?.cacheWriteTokens ?? 0 })),
      requestsByModel,
      modelDistribution: requestsByModel.map(({ model, count }) => ({ model, value: count, percentage: totalRequests > 0 ? Math.round((count / totalRequests) * 100) : 0 })),
      successRate: slots.map((date) => {
        const success = seriesBySlot.get(date)?.successCount ?? 0;
        const error = seriesBySlot.get(date)?.errorCount ?? 0;
        const total = success + error;
        return { date, success, error, successRate: total > 0 ? Math.round((success / total) * 1000) / 10 : 0, errorRate: total > 0 ? Math.round((error / total) * 1000) / 10 : 0 };
      }),
      durationOverTime: slots.map((date) => ({ date, avg: seriesBySlot.get(date)?.avgDuration ?? null, p30: seriesBySlot.get(date)?.p30 ?? null, p50: seriesBySlot.get(date)?.p50 ?? null, p60: seriesBySlot.get(date)?.p60 ?? null, p75: seriesBySlot.get(date)?.p75 ?? null, p90: seriesBySlot.get(date)?.p90 ?? null, p95: seriesBySlot.get(date)?.p95 ?? null, p99: seriesBySlot.get(date)?.p99 ?? null })),
      granularity: config.granularity,
      totals: { totalRequests, totalInputTokens: roundValue(totalsRow?.totalInputTokens), totalOutputTokens: roundValue(totalsRow?.totalOutputTokens), totalCachedTokens: roundValue(totalsRow?.totalCachedTokens), totalCacheWriteTokens: roundValue(totalsRow?.totalCacheWriteTokens), avgDuration: roundNullable(totalsRow?.avgDuration) ?? 0, durationPercentiles: { p30: roundValue(totalsRow?.p30), p50: roundValue(totalsRow?.p50), p60: roundValue(totalsRow?.p60), p75: roundValue(totalsRow?.p75), p90: roundValue(totalsRow?.p90), p95: roundValue(totalsRow?.p95), p99: roundValue(totalsRow?.p99) }, successRate: totalRequests > 0 ? Math.round((successfulRequests / totalRequests) * 100) : 0 },
    };

    return { success: true as const, data: analyticsData };
});

export const getAnalyticsData = Effect.fn("analytics.data")(function* (
  userId: string,
  input?: AnalyticsDataInput
) {
  const result = yield* analyticsFor(userId, input?.filter ?? "30d", input?.apiKeyId, {
    includeSeries: input?.includeSeries ?? true,
  });
  if (!result.success) return yield* internal(result.error);
  return result.data;
});

export const getAnalyticsSeries = Effect.fn("analytics.series")(function* (
  userId: string,
  input?: AnalyticsSeriesInput
) {
  const result = yield* analyticsFor(userId, input?.filter ?? "30d", input?.apiKeyId, {
    includeSummary: false,
    includeSeries: true,
  });
  if (!result.success) return yield* internal(result.error);

  return {
    requestsOverTime: result.data.requestsOverTime,
    tokenUsage: result.data.tokenUsage,
    successRate: result.data.successRate,
    durationOverTime: result.data.durationOverTime,
    granularity: result.data.granularity,
  } satisfies AnalyticsSeriesData;
});

export const getAnalyticsOverview = Effect.fn("analytics.overview")(function* (userId: string) {
  const result = yield* analyticsFor(userId, "24h", undefined, { includeSeries: false });
  if (!result.success) return yield* internal(result.error);

  const totals = result.data.totals;
  return {
    requests: totals.totalRequests,
    totalRequests: totals.totalRequests,
    tokens: totals.totalInputTokens + totals.totalOutputTokens,
    totalTokens: totals.totalInputTokens + totals.totalOutputTokens,
    errors: Math.round(totals.totalRequests * ((100 - totals.successRate) / 100)),
    successRate: totals.successRate,
    avgDuration: totals.avgDuration,
  };
});

export const getUsageRows = Effect.fn("analytics.usageRows")(function* (
  userId: string,
  input?: AnalyticsUsageInput
) {
  const resolvedFilter = filterConfig(input?.range ?? "30d");
  if (!resolvedFilter.success) return yield* internal(resolvedFilter.error);

  return yield* fromPromise(
    () =>
      db
      .select({
        id: usageLog.id,
        createdAt: usageLog.createdAt,
        model: usageLog.model,
        provider: providerAccount.provider,
        statusCode: usageLog.statusCode,
        inputTokens: usageLog.inputTokens,
        outputTokens: usageLog.outputTokens,
        cachedTokens: usageLog.cachedTokens,
        cacheWriteTokens: usageLog.cacheWriteTokens,
        totalTokens: sql<number>`${usageLog.inputTokens} + ${usageLog.outputTokens}`,
        duration: usageLog.duration,
      })
      .from(usageLog)
      .leftJoin(providerAccount, eq(usageLog.providerAccountId, providerAccount.id))
      .where(and(eq(usageLog.userId, userId), gte(usageLog.createdAt, resolvedFilter.data.startDate), lte(usageLog.createdAt, resolvedFilter.data.endDate)))
      .orderBy(sql`${usageLog.createdAt} desc`)
      .limit(100),
    "Failed to fetch usage rows"
  );
});
