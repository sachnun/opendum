import { getCachedModelStats, setCachedModelStats } from "@/lib/cache/models-cache";
import { db } from "@opendum/shared/db";
import { usageLog } from "@opendum/shared/db/schema";
import { and, eq, gte, sql } from "drizzle-orm";
import { resolveModelAlias } from "@opendum/shared/proxy/models";

export const MODEL_STATS_DAYS = 30;
export const MODEL_DURATION_LOOKBACK_HOURS = 24;

export interface ModelStats {
  totalRequests: number;
  successRate: number | null;
  dailyRequests: Array<{ date: string; count: number }>;
  avgDurationLastDay: number | null;
  durationLast24Hours: Array<{ time: string; avgDuration: number | null }>;
}

interface CachedModelStatsPayload {
  statsByModel: Record<string, ModelStats>;
}

interface RawModelStats {
  totalRequests: number;
  successfulRequests: number;
  dailyCounts: Map<string, number>;
  durationByHour: Map<string, { total: number; count: number }>;
}

export function buildDayKeys(days: number): string[] {
  const now = new Date();
  const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  return Array.from({ length: days }, (_, index) => {
    const date = new Date(todayUtc);
    date.setUTCDate(todayUtc.getUTCDate() - (days - 1 - index));
    return date.toISOString().split("T")[0];
  });
}

export function buildHourKeys(hours: number): string[] {
  const now = new Date();
  const currentHourUtc = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours())
  );

  return Array.from({ length: hours }, (_, index) => {
    const date = new Date(currentHourUtc);
    date.setUTCHours(currentHourUtc.getUTCHours() - (hours - 1 - index));
    return date.toISOString();
  });
}

function normalizeLoggedModel(model: string): string {
  const slashIndex = model.indexOf("/");
  const baseModel = slashIndex >= 0 ? model.slice(slashIndex + 1) : model;
  return resolveModelAlias(baseModel);
}

export function buildEmptyModelStats(dayKeys: string[], hourKeys: string[]): ModelStats {
  return {
    totalRequests: 0,
    successRate: null,
    dailyRequests: dayKeys.map((day) => ({ date: day, count: 0 })),
    avgDurationLastDay: null,
    durationLast24Hours: hourKeys.map((time) => ({ time, avgDuration: null })),
  };
}

async function computeModelStatsByModel(
  userId: string,
  allModels: string[]
): Promise<Record<string, ModelStats>> {
  const dayKeys = buildDayKeys(MODEL_STATS_DAYS);
  const dayKeySet = new Set(dayKeys);
  const hourKeys = buildHourKeys(MODEL_DURATION_LOOKBACK_HOURS);
  const hourKeySet = new Set(hourKeys);
  const durationStartDate = new Date(hourKeys[0]);
  const statsStartDate = new Date(`${dayKeys[0]}T00:00:00.000Z`);
  const supportedModelSet = new Set(allModels);

  const normalizedModelExpression = sql<string>`case
    when strpos(${usageLog.model}, '/') > 0 then split_part(${usageLog.model}, '/', 2)
    else ${usageLog.model}
  end`;
  const dayBucketExpression = sql<Date>`date_trunc('day', ${usageLog.createdAt})`;
  const hourBucketExpression = sql<Date>`date_trunc('hour', ${usageLog.createdAt})`;

  const [dailyRows, durationRows] = await Promise.all([
    db
      .select({
        model: normalizedModelExpression,
        dayBucket: dayBucketExpression,
        requestCount: sql<number>`count(*)`,
        successCount: sql<number>`count(*) filter (where ${usageLog.statusCode} >= 200 and ${usageLog.statusCode} < 400)`,
      })
      .from(usageLog)
      .where(and(eq(usageLog.userId, userId), gte(usageLog.createdAt, statsStartDate)))
      .groupBy(normalizedModelExpression, dayBucketExpression),
    db
      .select({
        model: normalizedModelExpression,
        hourBucket: hourBucketExpression,
        durationTotal: sql<number>`coalesce(sum(${usageLog.duration}), 0)`,
        durationCount: sql<number>`count(${usageLog.duration})`,
      })
      .from(usageLog)
      .where(and(eq(usageLog.userId, userId), gte(usageLog.createdAt, durationStartDate)))
      .groupBy(normalizedModelExpression, hourBucketExpression),
  ]);

  const rawStatsByModel = new Map<string, RawModelStats>();

  for (const row of dailyRows) {
    const modelId = normalizeLoggedModel(row.model);
    if (!supportedModelSet.has(modelId)) {
      continue;
    }

    const dayDate = row.dayBucket instanceof Date ? row.dayBucket : new Date(row.dayBucket);
    if (Number.isNaN(dayDate.getTime())) {
      continue;
    }

    const dayKey = dayDate.toISOString().split("T")[0];
    if (!dayKeySet.has(dayKey)) {
      continue;
    }

    const current =
      rawStatsByModel.get(modelId) ??
      {
        totalRequests: 0,
        successfulRequests: 0,
        dailyCounts: new Map<string, number>(),
        durationByHour: new Map<string, { total: number; count: number }>(),
      };

    const requestCount = Number(row.requestCount) || 0;
    const successCount = Number(row.successCount) || 0;

    current.totalRequests += requestCount;
    current.successfulRequests += successCount;
    current.dailyCounts.set(dayKey, (current.dailyCounts.get(dayKey) ?? 0) + requestCount);
    rawStatsByModel.set(modelId, current);
  }

  for (const row of durationRows) {
    const modelId = normalizeLoggedModel(row.model);
    if (!supportedModelSet.has(modelId)) {
      continue;
    }

    const hourDate = row.hourBucket instanceof Date ? row.hourBucket : new Date(row.hourBucket);
    if (Number.isNaN(hourDate.getTime())) {
      continue;
    }

    const hourKey = hourDate.toISOString();
    if (!hourKeySet.has(hourKey)) {
      continue;
    }

    const durationCount = Number(row.durationCount) || 0;
    const durationTotal = Number(row.durationTotal) || 0;
    if (durationCount <= 0) {
      continue;
    }

    const current =
      rawStatsByModel.get(modelId) ??
      {
        totalRequests: 0,
        successfulRequests: 0,
        dailyCounts: new Map<string, number>(),
        durationByHour: new Map<string, { total: number; count: number }>(),
      };

    const durationBucket = current.durationByHour.get(hourKey) ?? { total: 0, count: 0 };
    durationBucket.total += durationTotal;
    durationBucket.count += durationCount;
    current.durationByHour.set(hourKey, durationBucket);
    rawStatsByModel.set(modelId, current);
  }

  return Object.fromEntries(
    allModels.map((model) => {
      const modelStats = rawStatsByModel.get(model);
      if (!modelStats) {
        return [model, buildEmptyModelStats(dayKeys, hourKeys)];
      }

      const durationLast24Hours = hourKeys.map((time) => {
        const durationBucket = modelStats.durationByHour.get(time);
        return {
          time,
          avgDuration:
            durationBucket && durationBucket.count > 0
              ? Math.round(durationBucket.total / durationBucket.count)
              : null,
        };
      });

      const durationTotalLastDay = Array.from(modelStats.durationByHour.values()).reduce(
        (sum, durationBucket) => sum + durationBucket.total,
        0
      );
      const durationCountLastDay = Array.from(modelStats.durationByHour.values()).reduce(
        (sum, durationBucket) => sum + durationBucket.count,
        0
      );

      const stats: ModelStats = {
        totalRequests: modelStats.totalRequests,
        successRate:
          modelStats.totalRequests > 0
            ? Math.round((modelStats.successfulRequests / modelStats.totalRequests) * 100)
            : null,
        dailyRequests: dayKeys.map((day) => ({
          date: day,
          count: modelStats.dailyCounts.get(day) ?? 0,
        })),
        avgDurationLastDay:
          durationCountLastDay > 0
            ? Math.round(durationTotalLastDay / durationCountLastDay)
            : null,
        durationLast24Hours,
      };

      return [model, stats];
    })
  );
}

export async function getModelStatsByModel(
  userId: string,
  allModels: string[]
): Promise<Record<string, ModelStats>> {
  const cachedPayload = await getCachedModelStats<CachedModelStatsPayload>(userId);
  if (cachedPayload?.statsByModel) {
    return cachedPayload.statsByModel;
  }

  const statsByModel = await computeModelStatsByModel(userId, allModels);
  await setCachedModelStats<CachedModelStatsPayload>(userId, { statsByModel });
  return statsByModel;
}
