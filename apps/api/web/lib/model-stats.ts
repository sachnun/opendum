import { and, eq, gte, inArray, sql } from "drizzle-orm";

import { dayKeys, emptyStats, hourKeys, LOOKBACK_HOURS, MODEL_STATS_DAYS, type ModelStats } from "@opendum/models/stats";
import { db, usageLog } from "@opendum/database";
import { Effect } from "effect";
import { fromPromise } from "@opendum/api/web/lib/task";
import { keysOf, aliasOf } from "@opendum/api/web/lib/proxy/models";

interface RawModelStats {
  totalRequests: number;
  totalTokens: number;
  successfulRequests: number;
  durationTotal: number;
  durationCount: number;
  dailyCounts: Map<string, number>;
  durationByHour: Map<string, { total: number; count: number }>;
}

function rawStats(): RawModelStats {
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

function normalizeModel(model: string): string {
  const slashIndex = model.indexOf("/");
  const baseModel = slashIndex >= 0 ? model.slice(slashIndex + 1) : model;
  return aliasOf(baseModel);
}

export const statsByModel = Effect.fn("statsByModel")(function* (userId: string, allModels: string[]) {
  if (allModels.length === 0) return {} as Record<string, ModelStats>;

  const days = dayKeys(MODEL_STATS_DAYS);
  const dayKeySet = new Set(days);
  const hours = hourKeys(LOOKBACK_HOURS);
  const hourKeySet = new Set(hours);
  const durationStartDate = new Date(hours[0] ?? Date.now());
  const statsStartDate = new Date(`${days[0]}T00:00:00.000Z`);
  const supportedModelSet = new Set(allModels);


  const normalizedModelExpression = sql<string>`case
    when strpos(${usageLog.model}, '/') > 0 then split_part(${usageLog.model}, '/', 2)
    else ${usageLog.model}
  end`;
  const dayBucketExpression = sql<Date>`date_trunc('day', ${usageLog.createdAt})`;
  const hourBucketExpression = sql<Date>`date_trunc('hour', ${usageLog.createdAt})`;
  const modelWhere = and(eq(usageLog.userId, userId), inArray(normalizedModelExpression, Array.from(new Set(allModels.flatMap(keysOf)))));

  const allTimeRows = yield* fromPromise(
    () =>
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
    "Failed to load model usage"
  );

  const dailyRows = yield* fromPromise(
    () =>
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
    "Failed to load daily model usage"
  );

  const durationRows = yield* fromPromise(
    () =>
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
    "Failed to load model durations"
  );

  const rawByModel = new Map<string, RawModelStats>();

  for (const row of allTimeRows) {
    const modelId = normalizeModel(row.model);
    if (!supportedModelSet.has(modelId)) continue;

    const current = rawByModel.get(modelId) ?? rawStats();
    current.totalRequests += Number(row.requestCount) || 0;
    current.totalTokens += Number(row.totalTokens) || 0;
    current.successfulRequests += Number(row.successCount) || 0;
    current.durationTotal += Number(row.durationTotal) || 0;
    current.durationCount += Number(row.durationCount) || 0;
    rawByModel.set(modelId, current);
  }

  for (const row of dailyRows) {
    const modelId = normalizeModel(row.model);
    if (!supportedModelSet.has(modelId)) continue;

    const dayDate = row.dayBucket instanceof Date ? row.dayBucket : new Date(row.dayBucket);
    if (Number.isNaN(dayDate.getTime())) continue;

    const dayKey = dayDate.toISOString().split("T")[0] ?? "";
    if (!dayKeySet.has(dayKey)) continue;

    const current = rawByModel.get(modelId) ?? rawStats();

    const requestCount = Number(row.requestCount) || 0;

    current.dailyCounts.set(dayKey, (current.dailyCounts.get(dayKey) ?? 0) + requestCount);
    rawByModel.set(modelId, current);
  }

  for (const row of durationRows) {
    const modelId = normalizeModel(row.model);
    if (!supportedModelSet.has(modelId)) continue;

    const hourDate = row.hourBucket instanceof Date ? row.hourBucket : new Date(row.hourBucket);
    if (Number.isNaN(hourDate.getTime())) continue;

    const hourKey = hourDate.toISOString();
    if (!hourKeySet.has(hourKey)) continue;

    const durationCount = Number(row.durationCount) || 0;
    const durationTotal = Number(row.durationTotal) || 0;
    if (durationCount <= 0) continue;

    const current = rawByModel.get(modelId) ?? rawStats();

    const durationBucket = current.durationByHour.get(hourKey) ?? { total: 0, count: 0 };
    durationBucket.total += durationTotal;
    durationBucket.count += durationCount;
    current.durationByHour.set(hourKey, durationBucket);
    rawByModel.set(modelId, current);
  }

  return Object.fromEntries(
    allModels.map((model) => {
      const modelStats = rawByModel.get(model);
      if (!modelStats) {
        return [model, emptyStats(days, hours)];
      }

      const durationLast24Hours = hours.flatMap((time) => {
        const durationBucket = modelStats.durationByHour.get(time);
        return durationBucket && durationBucket.count > 0 ? [{ time, avgDuration: Math.round(durationBucket.total / durationBucket.count) }] : [];
      });

      return [model, {
        totalRequests: modelStats.totalRequests,
        totalTokens: modelStats.totalTokens,
        successRate: modelStats.totalRequests > 0 ? Math.round((modelStats.successfulRequests / modelStats.totalRequests) * 100) : null,
        dailyRequests: days.flatMap((day) => {
          const count = modelStats.dailyCounts.get(day) ?? 0;
          return count > 0 ? [{ date: day, count }] : [];
        }),
        avgDurationLastDay: modelStats.durationCount > 0 ? Math.round(modelStats.durationTotal / modelStats.durationCount) : null,
        durationLast24Hours,
      } satisfies ModelStats];
    })
  );
});
