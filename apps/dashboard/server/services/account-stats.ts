import { and, eq, gte, inArray, sql } from "drizzle-orm";

import { getAnalyticsCacheVersion } from "../lib/cache/analytics-cache";
import { db } from "../lib/db";
import { providerAccount, usageLog } from "../lib/db/schema";
import { getRedisJson, setRedisJson } from "../lib/redis-cache";
import { isKnownProvider, PROVIDER_ACCOUNT_KEYS, type ProviderAccountKey } from "./account-providers";

const PROVIDER_STATS_DAYS = 30;
const PROVIDER_DURATION_LOOKBACK_HOURS = 24;
const WARNING_INDICATOR_STALE_WINDOW_MS = 3 * 60 * 60 * 1000;
const PROVIDER_SUMMARY_STATS_CACHE_TTL_SECONDS = 30;

export const INDICATOR_WEIGHT = { normal: 0, warning: 1, error: 2 } as const;
export type ProviderAccountIndicator = keyof typeof INDICATOR_WEIGHT;
export type ProviderStats = {
  totalRequests: number;
  successRate: number | null;
  dailyRequests: Array<{ date: string; count: number }>;
  avgDurationLastDay: number | null;
  durationLast24Hours: Array<{ time: string; avgDuration: number | null }>;
};
type RawProviderStats = {
  totalRequests: number;
  successfulRequests: number;
  dailyCounts: Map<string, number>;
  durationByHour: Map<string, { total: number; count: number }>;
};

function buildDayKeys(days: number): string[] {
  const now = new Date();
  const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(todayUtc);
    date.setUTCDate(todayUtc.getUTCDate() - (days - 1 - index));
    return date.toISOString().split("T")[0] ?? "";
  });
}

function buildHourKeys(hours: number): string[] {
  const now = new Date();
  const currentHourUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours()));
  return Array.from({ length: hours }, (_, index) => {
    const date = new Date(currentHourUtc);
    date.setUTCHours(currentHourUtc.getUTCHours() - (hours - 1 - index));
    return date.toISOString();
  });
}

function toDate(value: Date | string | null): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toNumber(value: number | string | null | undefined): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function createRawStats(): RawProviderStats {
  return { totalRequests: 0, successfulRequests: 0, dailyCounts: new Map(), durationByHour: new Map() };
}

function buildEmptyProviderStats(dayKeys: string[], hourKeys: string[]): ProviderStats {
  return {
    totalRequests: 0,
    successRate: null,
    dailyRequests: dayKeys.map((date) => ({ date, count: 0 })),
    avgDurationLastDay: null,
    durationLast24Hours: hourKeys.map((time) => ({ time, avgDuration: null })),
  };
}

export function buildStatsFromRaw(raw: RawProviderStats | undefined, dayKeys: string[], hourKeys: string[]): ProviderStats {
  if (!raw) return buildEmptyProviderStats(dayKeys, hourKeys);
  const durationTotalLastDay = Array.from(raw.durationByHour.values()).reduce((sum, bucket) => sum + bucket.total, 0);
  const durationCountLastDay = Array.from(raw.durationByHour.values()).reduce((sum, bucket) => sum + bucket.count, 0);
  return {
    totalRequests: raw.totalRequests,
    successRate: raw.totalRequests > 0 ? Math.round((raw.successfulRequests / raw.totalRequests) * 100) : null,
    dailyRequests: dayKeys.map((date) => ({ date, count: raw.dailyCounts.get(date) ?? 0 })),
    avgDurationLastDay: durationCountLastDay > 0 ? Math.round(durationTotalLastDay / durationCountLastDay) : null,
    durationLast24Hours: hourKeys.map((time) => {
      const bucket = raw.durationByHour.get(time);
      return { time, avgDuration: bucket && bucket.count > 0 ? Math.round(bucket.total / bucket.count) : null };
    }),
  };
}

export function getAccountIndicator(lastErrorAt: Date | string | null, lastSuccessAt: Date | string | null, lastRecoveredByRotationAt: Date | string | null): ProviderAccountIndicator {
  const errorDate = toDate(lastErrorAt);
  if (!errorDate) return "normal";
  const recoveredTimeMs = Math.max(toDate(lastSuccessAt)?.getTime() ?? 0, toDate(lastRecoveredByRotationAt)?.getTime() ?? 0);
  if (recoveredTimeMs <= errorDate.getTime()) return "error";
  if (Date.now() - errorDate.getTime() > WARNING_INDICATOR_STALE_WINDOW_MS) return "normal";
  return "warning";
}

async function buildProviderStats(userId: string, provider?: string): Promise<{ dayKeys: string[]; hourKeys: string[]; statsByProvider: Map<ProviderAccountKey, RawProviderStats> }> {
  const dayKeys = buildDayKeys(PROVIDER_STATS_DAYS);
  const dayKeySet = new Set(dayKeys);
  const hourKeys = buildHourKeys(PROVIDER_DURATION_LOOKBACK_HOURS);
  const hourKeySet = new Set(hourKeys);
  const statsStartDate = new Date(`${dayKeys[0]}T00:00:00.000Z`);
  const durationStartDate = new Date(hourKeys[0] ?? Date.now());
  const dayBucketExpression = sql<Date>`date_trunc('day', ${usageLog.createdAt})`;
  const hourBucketExpression = sql<Date>`date_trunc('hour', ${usageLog.createdAt})`;
  const baseConditions = [eq(usageLog.userId, userId), eq(providerAccount.userId, userId)];
  const dailyConditions = [...baseConditions, gte(usageLog.createdAt, statsStartDate)];
  const durationConditions = [...baseConditions, gte(usageLog.createdAt, durationStartDate)];
  if (provider) {
    dailyConditions.push(eq(providerAccount.provider, provider));
    durationConditions.push(eq(providerAccount.provider, provider));
  }

  const [dailyUsageRows, durationRows] = await Promise.all([
    db.select({ provider: providerAccount.provider, dayBucket: dayBucketExpression, requestCount: sql<number>`count(*)`, successCount: sql<number>`count(*) filter (where ${usageLog.statusCode} >= 200 and ${usageLog.statusCode} < 400)` }).from(usageLog).innerJoin(providerAccount, eq(usageLog.providerAccountId, providerAccount.id)).where(and(...dailyConditions)).groupBy(providerAccount.provider, dayBucketExpression),
    db.select({ provider: providerAccount.provider, hourBucket: hourBucketExpression, durationTotal: sql<number>`coalesce(sum(${usageLog.duration}), 0)`, durationCount: sql<number>`count(${usageLog.duration})` }).from(usageLog).innerJoin(providerAccount, eq(usageLog.providerAccountId, providerAccount.id)).where(and(...durationConditions)).groupBy(providerAccount.provider, hourBucketExpression),
  ]);

  const statsByProvider = new Map<ProviderAccountKey, RawProviderStats>();
  for (const row of dailyUsageRows) {
    if (!isKnownProvider(row.provider)) continue;
    const date = toDate(row.dayBucket);
    if (!date) continue;
    const dayKey = date.toISOString().split("T")[0] ?? "";
    if (!dayKeySet.has(dayKey)) continue;
    const current = statsByProvider.get(row.provider) ?? createRawStats();
    const requestCount = toNumber(row.requestCount);
    current.totalRequests += requestCount;
    current.successfulRequests += toNumber(row.successCount);
    current.dailyCounts.set(dayKey, (current.dailyCounts.get(dayKey) ?? 0) + requestCount);
    statsByProvider.set(row.provider, current);
  }
  for (const row of durationRows) {
    if (!isKnownProvider(row.provider)) continue;
    addDurationBucket(statsByProvider, row.provider, row.hourBucket, row.durationTotal, row.durationCount, hourKeySet);
  }
  return { dayKeys, hourKeys, statsByProvider };
}

function addDurationBucket(stats: Map<string, RawProviderStats>, key: string, rawHour: Date | string | null, rawTotal: number | string | null, rawCount: number | string | null, hourKeySet: Set<string>) {
  const date = toDate(rawHour);
  if (!date) return;
  const hourKey = date.toISOString();
  if (!hourKeySet.has(hourKey)) return;
  const durationCount = toNumber(rawCount);
  if (durationCount <= 0) return;
  const current = stats.get(key) ?? createRawStats();
  const durationBucket = current.durationByHour.get(hourKey) ?? { total: 0, count: 0 };
  durationBucket.total += toNumber(rawTotal);
  durationBucket.count += durationCount;
  current.durationByHour.set(hourKey, durationBucket);
  stats.set(key, current);
}

export async function getCachedProviderSummaryStats(userId: string): Promise<Record<ProviderAccountKey, ProviderStats>> {
  const version = await getAnalyticsCacheVersion(userId);
  const cacheKey = `opendum:accounts:summary-stats:${userId}:v${version}`;
  const cached = await getRedisJson<Record<ProviderAccountKey, ProviderStats>>(cacheKey);
  if (cached) return cached;
  const providerUsage = await buildProviderStats(userId);
  const stats = Object.fromEntries(PROVIDER_ACCOUNT_KEYS.map((provider) => [provider, buildStatsFromRaw(providerUsage.statsByProvider.get(provider), providerUsage.dayKeys, providerUsage.hourKeys)])) as Record<ProviderAccountKey, ProviderStats>;
  await setRedisJson(cacheKey, stats, PROVIDER_SUMMARY_STATS_CACHE_TTL_SECONDS);
  return stats;
}

export async function buildAccountStats(userId: string, accountIds: string[]): Promise<{ dayKeys: string[]; hourKeys: string[]; statsByAccountId: Map<string, RawProviderStats> }> {
  const dayKeys = buildDayKeys(PROVIDER_STATS_DAYS);
  const dayKeySet = new Set(dayKeys);
  const hourKeys = buildHourKeys(PROVIDER_DURATION_LOOKBACK_HOURS);
  const hourKeySet = new Set(hourKeys);
  const statsByAccountId = new Map<string, RawProviderStats>();
  if (accountIds.length === 0) return { dayKeys, hourKeys, statsByAccountId };

  const statsStartDate = new Date(`${dayKeys[0]}T00:00:00.000Z`);
  const durationStartDate = new Date(hourKeys[0] ?? Date.now());
  const dayBucketExpression = sql<Date>`date_trunc('day', ${usageLog.createdAt})`;
  const hourBucketExpression = sql<Date>`date_trunc('hour', ${usageLog.createdAt})`;
  const [dailyUsageRows, durationRows] = await Promise.all([
    db.select({ providerAccountId: usageLog.providerAccountId, dayBucket: dayBucketExpression, requestCount: sql<number>`count(*)`, successCount: sql<number>`count(*) filter (where ${usageLog.statusCode} >= 200 and ${usageLog.statusCode} < 400)` }).from(usageLog).where(and(eq(usageLog.userId, userId), inArray(usageLog.providerAccountId, accountIds), gte(usageLog.createdAt, statsStartDate))).groupBy(usageLog.providerAccountId, dayBucketExpression),
    db.select({ providerAccountId: usageLog.providerAccountId, hourBucket: hourBucketExpression, durationTotal: sql<number>`coalesce(sum(${usageLog.duration}), 0)`, durationCount: sql<number>`count(${usageLog.duration})` }).from(usageLog).where(and(eq(usageLog.userId, userId), inArray(usageLog.providerAccountId, accountIds), gte(usageLog.createdAt, durationStartDate))).groupBy(usageLog.providerAccountId, hourBucketExpression),
  ]);

  for (const row of dailyUsageRows) {
    if (!row.providerAccountId) continue;
    const date = toDate(row.dayBucket);
    if (!date) continue;
    const dayKey = date.toISOString().split("T")[0] ?? "";
    if (!dayKeySet.has(dayKey)) continue;
    const current = statsByAccountId.get(row.providerAccountId) ?? createRawStats();
    const requestCount = toNumber(row.requestCount);
    current.totalRequests += requestCount;
    current.successfulRequests += toNumber(row.successCount);
    current.dailyCounts.set(dayKey, (current.dailyCounts.get(dayKey) ?? 0) + requestCount);
    statsByAccountId.set(row.providerAccountId, current);
  }
  for (const row of durationRows) {
    if (row.providerAccountId) addDurationBucket(statsByAccountId, row.providerAccountId, row.hourBucket, row.durationTotal, row.durationCount, hourKeySet);
  }
  return { dayKeys, hourKeys, statsByAccountId };
}
