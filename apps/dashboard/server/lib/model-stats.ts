import { and, eq, gte, inArray, sql } from "drizzle-orm";

import { buildDayKeys, buildEmptyModelStats, buildHourKeys, MODEL_DURATION_LOOKBACK_HOURS, MODEL_STATS_DAYS, type ModelStats } from "../../lib/model-stats";
import { db } from "./db";
import { usageLog } from "./db/schema";
import { getModelLookupKeys, resolveModelAlias } from "./proxy/models";

interface RawModelStats {
  totalRequests: number;
  totalTokens: number;
  successfulRequests: number;
  durationTotal: number;
  durationCount: number;
  dailyCounts: Map<string, number>;
  durationByHour: Map<string, { total: number; count: number }>;
}

function createRawModelStats(): RawModelStats {
  return {
    totalRequests: 0,
    totalTokens: 0,
    successfulRequests: 0,
    durationTotal: 0,
    durationCount: 0,
    dailyCounts: new Map<string, number>(),
    durationByHour: new Map<string, { total: number; count: number }>(),
  };
}

function normalizeLoggedModel(model: string): string {
  const slashIndex = model.indexOf("/");
  const baseModel = slashIndex >= 0 ? model.slice(slashIndex + 1) : model;
  return resolveModelAlias(baseModel);
}

export async function getModelStatsByModel(userId: string, allModels: string[]): Promise<Record<string, ModelStats>> {
  if (allModels.length === 0) return {};

  const dayKeys = buildDayKeys(MODEL_STATS_DAYS);
  const dayKeySet = new Set(dayKeys);
  const hourKeys = buildHourKeys(MODEL_DURATION_LOOKBACK_HOURS);
  const hourKeySet = new Set(hourKeys);
  const durationStartDate = new Date(hourKeys[0] ?? Date.now());
  const statsStartDate = new Date(`${dayKeys[0]}T00:00:00.000Z`);
  const supportedModelSet = new Set(allModels);
  const lookupKeys = Array.from(new Set(allModels.flatMap(getModelLookupKeys)));

  const normalizedModelExpression = sql<string>`case
    when strpos(${usageLog.model}, '/') > 0 then split_part(${usageLog.model}, '/', 2)
    else ${usageLog.model}
  end`;
  const dayBucketExpression = sql<Date>`date_trunc('day', ${usageLog.createdAt})`;
  const hourBucketExpression = sql<Date>`date_trunc('hour', ${usageLog.createdAt})`;
  const modelWhere = and(eq(usageLog.userId, userId), inArray(normalizedModelExpression, lookupKeys));

  const [allTimeRows, dailyRows, durationRows] = await Promise.all([
    db
      .select({
        model: normalizedModelExpression,
        requestCount: sql<number>`count(*)`,
        totalTokens: sql<number>`coalesce(sum(${usageLog.inputTokens} + ${usageLog.outputTokens}), 0)`,
        successCount: sql<number>`count(*) filter (where ${usageLog.statusCode} >= 200 and ${usageLog.statusCode} < 400)`,
        durationTotal: sql<number>`coalesce(sum(${usageLog.duration}), 0)`,
        durationCount: sql<number>`count(${usageLog.duration})`,
      })
      .from(usageLog)
      .where(modelWhere)
      .groupBy(normalizedModelExpression),
    db
      .select({
        model: normalizedModelExpression,
        dayBucket: dayBucketExpression,
        requestCount: sql<number>`count(*)`,
        successCount: sql<number>`count(*) filter (where ${usageLog.statusCode} >= 200 and ${usageLog.statusCode} < 400)`,
      })
      .from(usageLog)
      .where(and(modelWhere, gte(usageLog.createdAt, statsStartDate)))
      .groupBy(normalizedModelExpression, dayBucketExpression),
    db
      .select({
        model: normalizedModelExpression,
        hourBucket: hourBucketExpression,
        durationTotal: sql<number>`coalesce(sum(${usageLog.duration}), 0)`,
        durationCount: sql<number>`count(${usageLog.duration})`,
      })
      .from(usageLog)
      .where(and(modelWhere, gte(usageLog.createdAt, durationStartDate)))
      .groupBy(normalizedModelExpression, hourBucketExpression),
  ]);

  const rawStatsByModel = new Map<string, RawModelStats>();

  for (const row of allTimeRows) {
    const modelId = normalizeLoggedModel(row.model);
    if (!supportedModelSet.has(modelId)) continue;

    const current = rawStatsByModel.get(modelId) ?? createRawModelStats();
    current.totalRequests += Number(row.requestCount) || 0;
    current.totalTokens += Number(row.totalTokens) || 0;
    current.successfulRequests += Number(row.successCount) || 0;
    current.durationTotal += Number(row.durationTotal) || 0;
    current.durationCount += Number(row.durationCount) || 0;
    rawStatsByModel.set(modelId, current);
  }

  for (const row of dailyRows) {
    const modelId = normalizeLoggedModel(row.model);
    if (!supportedModelSet.has(modelId)) continue;

    const dayDate = row.dayBucket instanceof Date ? row.dayBucket : new Date(row.dayBucket);
    if (Number.isNaN(dayDate.getTime())) continue;

    const dayKey = dayDate.toISOString().split("T")[0] ?? "";
    if (!dayKeySet.has(dayKey)) continue;

    const current = rawStatsByModel.get(modelId) ?? createRawModelStats();

    const requestCount = Number(row.requestCount) || 0;

    current.dailyCounts.set(dayKey, (current.dailyCounts.get(dayKey) ?? 0) + requestCount);
    rawStatsByModel.set(modelId, current);
  }

  for (const row of durationRows) {
    const modelId = normalizeLoggedModel(row.model);
    if (!supportedModelSet.has(modelId)) continue;

    const hourDate = row.hourBucket instanceof Date ? row.hourBucket : new Date(row.hourBucket);
    if (Number.isNaN(hourDate.getTime())) continue;

    const hourKey = hourDate.toISOString();
    if (!hourKeySet.has(hourKey)) continue;

    const durationCount = Number(row.durationCount) || 0;
    const durationTotal = Number(row.durationTotal) || 0;
    if (durationCount <= 0) continue;

    const current = rawStatsByModel.get(modelId) ?? createRawModelStats();

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
          avgDuration: durationBucket && durationBucket.count > 0 ? Math.round(durationBucket.total / durationBucket.count) : null,
        };
      });

      return [model, {
        totalRequests: modelStats.totalRequests,
        totalTokens: modelStats.totalTokens,
        successRate: modelStats.totalRequests > 0 ? Math.round((modelStats.successfulRequests / modelStats.totalRequests) * 100) : null,
        dailyRequests: dayKeys.map((day) => ({ date: day, count: modelStats.dailyCounts.get(day) ?? 0 })),
        avgDurationLastDay: modelStats.durationCount > 0 ? Math.round(modelStats.durationTotal / modelStats.durationCount) : null,
        durationLast24Hours,
      } satisfies ModelStats];
    })
  );
}
