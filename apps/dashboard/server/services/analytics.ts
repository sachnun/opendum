import { db } from "../lib/db";
import { providerAccount, proxyApiKey, usageLog } from "../lib/db/schema";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { z } from "zod";

import type { ActionResult } from "../utils/api";

const periodSchema = z.enum(["5m", "15m", "30m", "1h", "6h", "24h", "7d", "30d", "90d"]);
const analyticsFilterSchema = z.union([
  periodSchema,
  z.object({ from: z.string(), to: z.string() }),
]);
export const analyticsDataInputSchema = z.object({ filter: analyticsFilterSchema.optional(), apiKeyId: z.string().optional() }).optional();
export const analyticsByApiKeyInputSchema = z.object({ apiKeyId: z.string(), filter: analyticsFilterSchema.optional() });
export const analyticsUsageInputSchema = z.object({ range: periodSchema.default("24h") }).optional();

type Period = z.infer<typeof periodSchema>;
type AnalyticsFilter = z.infer<typeof analyticsFilterSchema>;
type Granularity = "10s" | "1m" | "5m" | "15m" | "1h" | "1d";

interface PeriodConfig {
  duration: number;
  granularity: Granularity;
  granularityMs: number;
}

export interface AnalyticsData {
  requestsOverTime: Array<{ date: string; count: number }>;
  tokenUsage: Array<{ date: string; input: number; output: number }>;
  requestsByModel: Array<{ model: string; count: number }>;
  modelDistribution: Array<{ model: string; value: number; percentage: number }>;
  successRate: Array<{ date: string; success: number; error: number; successRate?: number; errorRate?: number }>;
  durationOverTime: Array<{ date: string; avg: number | null; p30: number | null; p50: number | null; p60: number | null; p75: number | null; p90: number | null; p95: number | null; p99: number | null }>;
  granularity: Granularity;
  totals: {
    totalRequests: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    avgDuration: number;
    durationPercentiles: { p30: number; p50: number; p60: number; p75: number; p90: number; p95: number; p99: number };
    successRate: number;
  };
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

function resolveFilterConfig(filter: AnalyticsFilter): ActionResult<{ startDate: Date; endDate: Date; config: PeriodConfig }> {
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

function formatTimeSlot(date: Date, granularity: Granularity): string {
  const d = new Date(date);
  return GRANULARITY_ROUNDERS[granularity](d) || d.toISOString();
}

function generateTimeSlots(startDate: Date, endDate: Date, config: PeriodConfig): string[] {
  const slots: string[] = [];
  const current = new Date(startDate);
  GRANULARITY_ROUNDERS[config.granularity](current);
  while (current <= endDate) {
    slots.push(formatTimeSlot(current, config.granularity));
    current.setTime(current.getTime() + config.granularityMs);
  }
  return slots;
}

function getGranularityBucketSeconds(granularity: Granularity): number {
  return GRANULARITY_BUCKET_SECONDS[granularity];
}

function toRoundedValue(value: number | string | null | undefined): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 0;
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}

function toRoundedNullableValue(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  return toRoundedValue(value);
}

function toDateValue(value: Date | string | null): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function getAnalyticsDataForUser(
  userId: string,
  filter: AnalyticsFilter,
  apiKeyId?: string
): Promise<ActionResult<AnalyticsData>> {
  const resolvedFilter = resolveFilterConfig(filter);
  if (!resolvedFilter.success) return resolvedFilter;

  const { startDate, endDate, config } = resolvedFilter.data;
  try {
    if (apiKeyId) {
      const [ownedApiKey] = await db.select({ id: proxyApiKey.id }).from(proxyApiKey).where(and(eq(proxyApiKey.id, apiKeyId), eq(proxyApiKey.userId, userId))).limit(1);
      if (!ownedApiKey) return { success: false, error: "API key not found" };
    }

    const conditions = [eq(usageLog.userId, userId), gte(usageLog.createdAt, startDate), lte(usageLog.createdAt, endDate)];
    if (apiKeyId) conditions.push(eq(usageLog.proxyApiKeyId, apiKeyId));
    const whereCondition = and(...conditions);
    const bucketSeconds = sql.raw(String(getGranularityBucketSeconds(config.granularity)));
    const bucketExpression = sql<Date>`to_timestamp(floor(extract(epoch from ${usageLog.createdAt}) / ${bucketSeconds}) * ${bucketSeconds})`;

    const [timeSeriesRows, topModelRows, totalsRow] = await Promise.all([
      db.select({ bucket: bucketExpression, requestCount: sql<number>`count(*)`, inputTokens: sql<number>`coalesce(sum(${usageLog.inputTokens}), 0)`, outputTokens: sql<number>`coalesce(sum(${usageLog.outputTokens}), 0)`, successCount: sql<number>`count(*) filter (where ${usageLog.statusCode} >= 200 and ${usageLog.statusCode} < 400)`, errorCount: sql<number>`count(*) filter (where ${usageLog.statusCode} is null or ${usageLog.statusCode} < 200 or ${usageLog.statusCode} >= 400)`, avgDuration: sql<number | null>`avg(${usageLog.duration}) filter (where ${usageLog.duration} is not null)`, p30: sql<number | null>`percentile_cont(0.30) within group (order by ${usageLog.duration}) filter (where ${usageLog.duration} is not null)`, p50: sql<number | null>`percentile_cont(0.50) within group (order by ${usageLog.duration}) filter (where ${usageLog.duration} is not null)`, p60: sql<number | null>`percentile_cont(0.60) within group (order by ${usageLog.duration}) filter (where ${usageLog.duration} is not null)`, p75: sql<number | null>`percentile_cont(0.75) within group (order by ${usageLog.duration}) filter (where ${usageLog.duration} is not null)`, p90: sql<number | null>`percentile_cont(0.90) within group (order by ${usageLog.duration}) filter (where ${usageLog.duration} is not null)`, p95: sql<number | null>`percentile_cont(0.95) within group (order by ${usageLog.duration}) filter (where ${usageLog.duration} is not null)`, p99: sql<number | null>`percentile_cont(0.99) within group (order by ${usageLog.duration}) filter (where ${usageLog.duration} is not null)` }).from(usageLog).where(whereCondition).groupBy(bucketExpression).orderBy(bucketExpression),
      db.select({ model: usageLog.model, count: sql<number>`count(*)` }).from(usageLog).where(whereCondition).groupBy(usageLog.model).orderBy(sql`count(*) desc`).limit(10),
      db.select({ totalRequests: sql<number>`count(*)`, totalInputTokens: sql<number>`coalesce(sum(${usageLog.inputTokens}), 0)`, totalOutputTokens: sql<number>`coalesce(sum(${usageLog.outputTokens}), 0)`, avgDuration: sql<number | null>`avg(${usageLog.duration}) filter (where ${usageLog.duration} is not null)`, p30: sql<number | null>`percentile_cont(0.30) within group (order by ${usageLog.duration}) filter (where ${usageLog.duration} is not null)`, p50: sql<number | null>`percentile_cont(0.50) within group (order by ${usageLog.duration}) filter (where ${usageLog.duration} is not null)`, p60: sql<number | null>`percentile_cont(0.60) within group (order by ${usageLog.duration}) filter (where ${usageLog.duration} is not null)`, p75: sql<number | null>`percentile_cont(0.75) within group (order by ${usageLog.duration}) filter (where ${usageLog.duration} is not null)`, p90: sql<number | null>`percentile_cont(0.90) within group (order by ${usageLog.duration}) filter (where ${usageLog.duration} is not null)`, p95: sql<number | null>`percentile_cont(0.95) within group (order by ${usageLog.duration}) filter (where ${usageLog.duration} is not null)`, p99: sql<number | null>`percentile_cont(0.99) within group (order by ${usageLog.duration}) filter (where ${usageLog.duration} is not null)`, successfulRequests: sql<number>`count(*) filter (where ${usageLog.statusCode} >= 200 and ${usageLog.statusCode} < 400)` }).from(usageLog).where(whereCondition).then((rows) => rows[0]),
    ]);

    const timeSeriesBySlot = new Map<string, { requestCount: number; inputTokens: number; outputTokens: number; successCount: number; errorCount: number; avgDuration: number | null; p30: number | null; p50: number | null; p60: number | null; p75: number | null; p90: number | null; p95: number | null; p99: number | null }>();
    for (const row of timeSeriesRows) {
      const bucketDate = toDateValue(row.bucket);
      if (!bucketDate) continue;
      timeSeriesBySlot.set(formatTimeSlot(bucketDate, config.granularity), { requestCount: toRoundedValue(row.requestCount), inputTokens: toRoundedValue(row.inputTokens), outputTokens: toRoundedValue(row.outputTokens), successCount: toRoundedValue(row.successCount), errorCount: toRoundedValue(row.errorCount), avgDuration: toRoundedNullableValue(row.avgDuration), p30: toRoundedNullableValue(row.p30), p50: toRoundedNullableValue(row.p50), p60: toRoundedNullableValue(row.p60), p75: toRoundedNullableValue(row.p75), p90: toRoundedNullableValue(row.p90), p95: toRoundedNullableValue(row.p95), p99: toRoundedNullableValue(row.p99) });
    }

    const timeSlots = generateTimeSlots(startDate, endDate, config);
    const requestsByModel = topModelRows.map((row) => ({ model: row.model, count: toRoundedValue(row.count) }));
    const totalRequests = toRoundedValue(totalsRow?.totalRequests);
    const successfulRequests = toRoundedValue(totalsRow?.successfulRequests);
    const analyticsData: AnalyticsData = {
      requestsOverTime: timeSlots.map((date) => ({ date, count: timeSeriesBySlot.get(date)?.requestCount ?? 0 })),
      tokenUsage: timeSlots.map((date) => ({ date, input: timeSeriesBySlot.get(date)?.inputTokens ?? 0, output: timeSeriesBySlot.get(date)?.outputTokens ?? 0 })),
      requestsByModel,
      modelDistribution: requestsByModel.map(({ model, count }) => ({ model, value: count, percentage: totalRequests > 0 ? Math.round((count / totalRequests) * 100) : 0 })),
      successRate: timeSlots.map((date) => {
        const success = timeSeriesBySlot.get(date)?.successCount ?? 0;
        const error = timeSeriesBySlot.get(date)?.errorCount ?? 0;
        const total = success + error;
        return { date, success, error, successRate: total > 0 ? Math.round((success / total) * 1000) / 10 : 0, errorRate: total > 0 ? Math.round((error / total) * 1000) / 10 : 0 };
      }),
      durationOverTime: timeSlots.map((date) => ({ date, avg: timeSeriesBySlot.get(date)?.avgDuration ?? null, p30: timeSeriesBySlot.get(date)?.p30 ?? null, p50: timeSeriesBySlot.get(date)?.p50 ?? null, p60: timeSeriesBySlot.get(date)?.p60 ?? null, p75: timeSeriesBySlot.get(date)?.p75 ?? null, p90: timeSeriesBySlot.get(date)?.p90 ?? null, p95: timeSeriesBySlot.get(date)?.p95 ?? null, p99: timeSeriesBySlot.get(date)?.p99 ?? null })),
      granularity: config.granularity,
      totals: { totalRequests, totalInputTokens: toRoundedValue(totalsRow?.totalInputTokens), totalOutputTokens: toRoundedValue(totalsRow?.totalOutputTokens), avgDuration: toRoundedNullableValue(totalsRow?.avgDuration) ?? 0, durationPercentiles: { p30: toRoundedValue(totalsRow?.p30), p50: toRoundedValue(totalsRow?.p50), p60: toRoundedValue(totalsRow?.p60), p75: toRoundedValue(totalsRow?.p75), p90: toRoundedValue(totalsRow?.p90), p95: toRoundedValue(totalsRow?.p95), p99: toRoundedValue(totalsRow?.p99) }, successRate: totalRequests > 0 ? Math.round((successfulRequests / totalRequests) * 100) : 0 },
    };

    return { success: true, data: analyticsData };
  } catch (error) {
    console.error("Failed to fetch analytics:", error);
    return { success: false, error: "Failed to fetch analytics data" };
  }
}

export async function getAnalyticsData(userId: string, input?: z.infer<typeof analyticsDataInputSchema>) {
  const result = await getAnalyticsDataForUser(userId, input?.filter ?? "24h", input?.apiKeyId);
  if (!result.success) throw new Error(result.error);
  return result.data;
}

export async function getAnalyticsOverview(userId: string) {
  const result = await getAnalyticsDataForUser(userId, "24h");
  if (!result.success) throw new Error(result.error);

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
}

export async function getAnalyticsByApiKey(userId: string, input: z.infer<typeof analyticsByApiKeyInputSchema>) {
  const result = await getAnalyticsDataForUser(userId, input.filter ?? "24h", input.apiKeyId);
  if (!result.success) throw new Error(result.error);

  const totals = result.data.totals;
  return {
    ...result.data,
    requests: totals.totalRequests,
    totalRequests: totals.totalRequests,
    tokens: totals.totalInputTokens + totals.totalOutputTokens,
    totalTokens: totals.totalInputTokens + totals.totalOutputTokens,
    errors: Math.round(totals.totalRequests * ((100 - totals.successRate) / 100)),
  };
}

export async function getUsageRows(userId: string, input?: z.infer<typeof analyticsUsageInputSchema>) {
  const resolvedFilter = resolveFilterConfig(input?.range ?? "24h");
  if (!resolvedFilter.success) throw new Error(resolvedFilter.error);

  try {
    return await db
      .select({
        id: usageLog.id,
        createdAt: usageLog.createdAt,
        model: usageLog.model,
        provider: providerAccount.provider,
        statusCode: usageLog.statusCode,
        inputTokens: usageLog.inputTokens,
        outputTokens: usageLog.outputTokens,
        totalTokens: sql<number>`${usageLog.inputTokens} + ${usageLog.outputTokens}`,
        duration: usageLog.duration,
      })
      .from(usageLog)
      .leftJoin(providerAccount, eq(usageLog.providerAccountId, providerAccount.id))
      .where(and(eq(usageLog.userId, userId), gte(usageLog.createdAt, resolvedFilter.data.startDate), lte(usageLog.createdAt, resolvedFilter.data.endDate)))
      .orderBy(sql`${usageLog.createdAt} desc`)
      .limit(100);
  } catch (error) {
    console.error("Failed to fetch usage rows:", error);
    throw new Error("Failed to fetch usage rows");
  }
}
