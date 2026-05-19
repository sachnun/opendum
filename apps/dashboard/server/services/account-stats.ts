import { and, eq, gte, inArray, sql } from "drizzle-orm";

import { db } from "../lib/db";
import { providerAccount, usageLog } from "../lib/db/schema";
import { isKnownProvider, PROVIDER_ACCOUNT_KEYS, type ProviderAccountKey } from "./account-providers";

const PROVIDER_STATS_DAYS = 30;
const PROVIDER_DURATION_LOOKBACK_HOURS = 24;
const WARNING_INDICATOR_STALE_WINDOW_MS = 3 * 60 * 60 * 1000;

export const INDICATOR_WEIGHT = { normal: 0, warning: 1, error: 2 } as const;
export type ProviderAccountIndicator = keyof typeof INDICATOR_WEIGHT;
export type ProviderStats = {
  totalRequests: number;
  totalTokens: number;
  successRate: number | null;
  dailyRequests: Array<{ date: string; count: number }>;
  avgDurationLastDay: number | null;
  durationLast24Hours: Array<{ time: string; avgDuration: number }>;
};
type RawProviderStats = {
  totalRequests: number;
  totalTokens: number;
  successfulRequests: number;
  durationTotal: number;
  durationCount: number;
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
  return { totalRequests: 0, totalTokens: 0, successfulRequests: 0, durationTotal: 0, durationCount: 0, dailyCounts: new Map(), durationByHour: new Map() };
}

export function buildEmptyProviderStats(_dayKeys = buildDayKeys(PROVIDER_STATS_DAYS), _hourKeys = buildHourKeys(PROVIDER_DURATION_LOOKBACK_HOURS)): ProviderStats {
  return {
    totalRequests: 0,
    totalTokens: 0,
    successRate: null,
    dailyRequests: [],
    avgDurationLastDay: null,
    durationLast24Hours: [],
  };
}

function buildStatsFromRaw(raw: RawProviderStats | undefined, dayKeys: string[], hourKeys: string[]): ProviderStats {
  if (!raw) return buildEmptyProviderStats(dayKeys, hourKeys);
  return {
    totalRequests: raw.totalRequests,
    totalTokens: raw.totalTokens,
    successRate: raw.totalRequests > 0 ? Math.round((raw.successfulRequests / raw.totalRequests) * 100) : null,
    dailyRequests: dayKeys.flatMap((date) => {
      const count = raw.dailyCounts.get(date) ?? 0;
      return count > 0 ? [{ date, count }] : [];
    }),
    avgDurationLastDay: raw.durationCount > 0 ? Math.round(raw.durationTotal / raw.durationCount) : null,
    durationLast24Hours: hourKeys.flatMap((time) => {
      const bucket = raw.durationByHour.get(time);
      return bucket && bucket.count > 0 ? [{ time, avgDuration: Math.round(bucket.total / bucket.count) }] : [];
    }),
  };
}

export function getAccountIndicator(lastErrorAt: Date | string | null, lastSuccessAt: Date | string | null, lastRecoveredByRotationAt: Date | string | null, lastUsedAt: Date | string | null): ProviderAccountIndicator {
  const errorDate = toDate(lastErrorAt);
  if (!errorDate) return "normal";
  const recoveredTimeMs = Math.max(toDate(lastSuccessAt)?.getTime() ?? 0, toDate(lastRecoveredByRotationAt)?.getTime() ?? 0, toDate(lastUsedAt)?.getTime() ?? 0);
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
  const allTimeConditions = [...baseConditions];
  const dailyConditions = [...baseConditions, gte(usageLog.createdAt, statsStartDate)];
  const durationConditions = [...baseConditions, gte(usageLog.createdAt, durationStartDate)];
  if (provider) {
    allTimeConditions.push(eq(providerAccount.provider, provider));
    dailyConditions.push(eq(providerAccount.provider, provider));
    durationConditions.push(eq(providerAccount.provider, provider));
  }

  const [allTimeRows, dailyUsageRows, durationRows] = await Promise.all([
    db.select({ provider: providerAccount.provider, requestCount: sql<number>`count(*)`, totalTokens: sql<number>`coalesce(sum(${usageLog.inputTokens} + ${usageLog.outputTokens}), 0)`, successCount: sql<number>`count(*) filter (where ${usageLog.statusCode} >= 200 and ${usageLog.statusCode} < 400)`, durationTotal: sql<number>`coalesce(sum(${usageLog.duration}), 0)`, durationCount: sql<number>`count(${usageLog.duration})` }).from(usageLog).innerJoin(providerAccount, eq(usageLog.providerAccountId, providerAccount.id)).where(and(...allTimeConditions)).groupBy(providerAccount.provider),
    db.select({ provider: providerAccount.provider, dayBucket: dayBucketExpression, requestCount: sql<number>`count(*)`, successCount: sql<number>`count(*) filter (where ${usageLog.statusCode} >= 200 and ${usageLog.statusCode} < 400)` }).from(usageLog).innerJoin(providerAccount, eq(usageLog.providerAccountId, providerAccount.id)).where(and(...dailyConditions)).groupBy(providerAccount.provider, dayBucketExpression),
    db.select({ provider: providerAccount.provider, hourBucket: hourBucketExpression, durationTotal: sql<number>`coalesce(sum(${usageLog.duration}), 0)`, durationCount: sql<number>`count(${usageLog.duration})` }).from(usageLog).innerJoin(providerAccount, eq(usageLog.providerAccountId, providerAccount.id)).where(and(...durationConditions)).groupBy(providerAccount.provider, hourBucketExpression),
  ]);

  const statsByProvider = new Map<ProviderAccountKey, RawProviderStats>();
  for (const row of allTimeRows) {
    if (!isKnownProvider(row.provider)) continue;
    const current = statsByProvider.get(row.provider) ?? createRawStats();
    current.totalRequests += toNumber(row.requestCount);
    current.totalTokens += toNumber(row.totalTokens);
    current.successfulRequests += toNumber(row.successCount);
    current.durationTotal += toNumber(row.durationTotal);
    current.durationCount += toNumber(row.durationCount);
    statsByProvider.set(row.provider, current);
  }
  for (const row of dailyUsageRows) {
    if (!isKnownProvider(row.provider)) continue;
    const date = toDate(row.dayBucket);
    if (!date) continue;
    const dayKey = date.toISOString().split("T")[0] ?? "";
    if (!dayKeySet.has(dayKey)) continue;
    const current = statsByProvider.get(row.provider) ?? createRawStats();
    const requestCount = toNumber(row.requestCount);
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

export async function getProviderSummaryStats(userId: string): Promise<Record<ProviderAccountKey, ProviderStats>> {
  const providerUsage = await buildProviderStats(userId);
  const stats = Object.fromEntries(PROVIDER_ACCOUNT_KEYS.map((provider) => [provider, buildStatsFromRaw(providerUsage.statsByProvider.get(provider), providerUsage.dayKeys, providerUsage.hourKeys)])) as Record<ProviderAccountKey, ProviderStats>;
  return stats;
}

export async function buildAccountStats(userId: string, accountIds: string[]): Promise<Record<string, ProviderStats>> {
  const dayKeys = buildDayKeys(PROVIDER_STATS_DAYS);
  const dayKeySet = new Set(dayKeys);
  const hourKeys = buildHourKeys(PROVIDER_DURATION_LOOKBACK_HOURS);
  const hourKeySet = new Set(hourKeys);
  const rawStatsByAccountId = new Map<string, RawProviderStats>();
  if (accountIds.length === 0) return {};

  const statsStartDate = new Date(`${dayKeys[0]}T00:00:00.000Z`);
  const durationStartDate = new Date(hourKeys[0] ?? Date.now());
  const dayBucketExpression = sql<Date>`date_trunc('day', ${usageLog.createdAt})`;
  const hourBucketExpression = sql<Date>`date_trunc('hour', ${usageLog.createdAt})`;
  const [allTimeRows, dailyUsageRows, durationRows] = await Promise.all([
    db.select({ providerAccountId: usageLog.providerAccountId, requestCount: sql<number>`count(*)`, totalTokens: sql<number>`coalesce(sum(${usageLog.inputTokens} + ${usageLog.outputTokens}), 0)`, successCount: sql<number>`count(*) filter (where ${usageLog.statusCode} >= 200 and ${usageLog.statusCode} < 400)`, durationTotal: sql<number>`coalesce(sum(${usageLog.duration}), 0)`, durationCount: sql<number>`count(${usageLog.duration})` }).from(usageLog).where(and(eq(usageLog.userId, userId), inArray(usageLog.providerAccountId, accountIds))).groupBy(usageLog.providerAccountId),
    db.select({ providerAccountId: usageLog.providerAccountId, dayBucket: dayBucketExpression, requestCount: sql<number>`count(*)`, successCount: sql<number>`count(*) filter (where ${usageLog.statusCode} >= 200 and ${usageLog.statusCode} < 400)` }).from(usageLog).where(and(eq(usageLog.userId, userId), inArray(usageLog.providerAccountId, accountIds), gte(usageLog.createdAt, statsStartDate))).groupBy(usageLog.providerAccountId, dayBucketExpression),
    db.select({ providerAccountId: usageLog.providerAccountId, hourBucket: hourBucketExpression, durationTotal: sql<number>`coalesce(sum(${usageLog.duration}), 0)`, durationCount: sql<number>`count(${usageLog.duration})` }).from(usageLog).where(and(eq(usageLog.userId, userId), inArray(usageLog.providerAccountId, accountIds), gte(usageLog.createdAt, durationStartDate))).groupBy(usageLog.providerAccountId, hourBucketExpression),
  ]);

  for (const row of allTimeRows) {
    if (!row.providerAccountId) continue;
    const current = rawStatsByAccountId.get(row.providerAccountId) ?? createRawStats();
    current.totalRequests += toNumber(row.requestCount);
    current.totalTokens += toNumber(row.totalTokens);
    current.successfulRequests += toNumber(row.successCount);
    current.durationTotal += toNumber(row.durationTotal);
    current.durationCount += toNumber(row.durationCount);
    rawStatsByAccountId.set(row.providerAccountId, current);
  }

  for (const row of dailyUsageRows) {
    if (!row.providerAccountId) continue;
    const date = toDate(row.dayBucket);
    if (!date) continue;
    const dayKey = date.toISOString().split("T")[0] ?? "";
    if (!dayKeySet.has(dayKey)) continue;
    const current = rawStatsByAccountId.get(row.providerAccountId) ?? createRawStats();
    const requestCount = toNumber(row.requestCount);
    current.dailyCounts.set(dayKey, (current.dailyCounts.get(dayKey) ?? 0) + requestCount);
    rawStatsByAccountId.set(row.providerAccountId, current);
  }
  for (const row of durationRows) {
    if (row.providerAccountId) addDurationBucket(rawStatsByAccountId, row.providerAccountId, row.hourBucket, row.durationTotal, row.durationCount, hourKeySet);
  }
  return Object.fromEntries(accountIds.map((accountId) => [accountId, buildStatsFromRaw(rawStatsByAccountId.get(accountId), dayKeys, hourKeys)]));
}
