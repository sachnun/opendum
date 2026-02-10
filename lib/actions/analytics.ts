"use server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";

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

export type ActionResult<T = void> =
  | { success: true; data: T }
  | { success: false; error: string };

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

function normalizeModelName(model: string): string {
  return model.replace("iflow/", "");
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

function calculatePercentile(sortedValues: number[], percentile: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }

  const position = (percentile / 100) * (sortedValues.length - 1);
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);

  if (lowerIndex === upperIndex) {
    return sortedValues[lowerIndex] ?? 0;
  }

  const lowerValue = sortedValues[lowerIndex] ?? 0;
  const upperValue = sortedValues[upperIndex] ?? lowerValue;
  const interpolationFactor = position - lowerIndex;

  return Math.round(lowerValue + (upperValue - lowerValue) * interpolationFactor);
}

function calculateDurationPercentiles(sortedDurations: number[]): DurationPercentiles {
  return {
    p30: calculatePercentile(sortedDurations, 30),
    p50: calculatePercentile(sortedDurations, 50),
    p60: calculatePercentile(sortedDurations, 60),
    p75: calculatePercentile(sortedDurations, 75),
    p90: calculatePercentile(sortedDurations, 90),
    p95: calculatePercentile(sortedDurations, 95),
    p99: calculatePercentile(sortedDurations, 99),
  };
}

export async function getAnalyticsData(
  filter: AnalyticsFilter,
  apiKeyId?: string
): Promise<ActionResult<AnalyticsData>> {
  const session = await auth();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  const userId = session.user.id;
  const resolvedFilter = resolveFilterConfig(filter);

  if (!resolvedFilter.success) {
    return resolvedFilter;
  }

  const { startDate, endDate, config } = resolvedFilter.data;

  try {
    if (apiKeyId) {
      const ownedApiKey = await prisma.proxyApiKey.findFirst({
        where: {
          id: apiKeyId,
          userId,
        },
        select: { id: true },
      });

      if (!ownedApiKey) {
        return { success: false, error: "API key not found" };
      }
    }

    // Fetch all logs in the period
    const logs = await prisma.usageLog.findMany({
      where: {
        userId,
        createdAt: { gte: startDate, lte: endDate },
        ...(apiKeyId ? { proxyApiKeyId: apiKeyId } : {}),
      },
      select: {
        model: true,
        inputTokens: true,
        outputTokens: true,
        statusCode: true,
        duration: true,
        createdAt: true,
      },
    });

    // Generate time slots for filling gaps based on granularity
    const timeSlots = generateTimeSlots(startDate, endDate, config);

    // Process requests over time
    const requestsBySlot = new Map<string, number>();
    timeSlots.forEach((slot) => requestsBySlot.set(slot, 0));
    logs.forEach((log) => {
      const slot = formatTimeSlot(log.createdAt, config.granularity);
      requestsBySlot.set(slot, (requestsBySlot.get(slot) || 0) + 1);
    });
    const requestsOverTime: RequestsOverTimeData[] = Array.from(
      requestsBySlot.entries()
    ).map(([date, count]) => ({ date, count }));

    // Process token usage over time
    const tokensBySlot = new Map<string, { input: number; output: number }>();
    timeSlots.forEach((slot) => tokensBySlot.set(slot, { input: 0, output: 0 }));
    logs.forEach((log) => {
      const slot = formatTimeSlot(log.createdAt, config.granularity);
      const current = tokensBySlot.get(slot) || { input: 0, output: 0 };
      tokensBySlot.set(slot, {
        input: current.input + log.inputTokens,
        output: current.output + log.outputTokens,
      });
    });
    const tokenUsage: TokenUsageData[] = Array.from(tokensBySlot.entries()).map(
      ([date, tokens]) => ({
        date,
        input: tokens.input,
        output: tokens.output,
      })
    );

    // Process duration stats over time (avg on chart, pXX in tooltip)
    const durationsBySlot = new Map<string, number[]>();
    timeSlots.forEach((slot) => durationsBySlot.set(slot, []));
    logs.forEach((log) => {
      if (log.duration === null) {
        return;
      }

      const slot = formatTimeSlot(log.createdAt, config.granularity);
      const current = durationsBySlot.get(slot) || [];
      current.push(log.duration);
      durationsBySlot.set(slot, current);
    });

    const durationOverTime: DurationOverTimeData[] = Array.from(durationsBySlot.entries()).map(
      ([date, durations]) => {
        if (durations.length === 0) {
          return {
            date,
            avg: null,
            p30: null,
            p50: null,
            p60: null,
            p75: null,
            p90: null,
            p95: null,
            p99: null,
          };
        }

        const sortedDurations = [...durations].sort((a, b) => a - b);
        const avg = Math.round(
          sortedDurations.reduce((sum, duration) => sum + duration, 0) / sortedDurations.length
        );

        return {
          date,
          avg,
          ...calculateDurationPercentiles(sortedDurations),
        };
      }
    );

    // Process requests by model
    const modelCounts = new Map<string, number>();
    logs.forEach((log) => {
      const model = normalizeModelName(log.model);
      modelCounts.set(model, (modelCounts.get(model) || 0) + 1);
    });
    const allModelsByCount = Array.from(modelCounts.entries())
      .map(([model, count]) => ({ model, count }))
      .sort((a, b) => b.count - a.count);

    const requestsByModel: RequestsByModelData[] = allModelsByCount.slice(0, 10); // Top 10 models

    // Process model distribution (for pie chart)
    const totalRequests = logs.length;
    const modelDistribution: ModelDistributionData[] = requestsByModel.map(
      ({ model, count }) => ({
        model,
        value: count,
        percentage: totalRequests > 0 ? Math.round((count / totalRequests) * 100) : 0,
      })
    );

    // Process success/error rate over time
    const successBySlot = new Map<string, { success: number; error: number }>();
    timeSlots.forEach((slot) =>
      successBySlot.set(slot, { success: 0, error: 0 })
    );
    logs.forEach((log) => {
      const slot = formatTimeSlot(log.createdAt, config.granularity);
      const current = successBySlot.get(slot) || { success: 0, error: 0 };
      const isSuccess = log.statusCode !== null && log.statusCode >= 200 && log.statusCode < 400;
      successBySlot.set(slot, {
        success: current.success + (isSuccess ? 1 : 0),
        error: current.error + (isSuccess ? 0 : 1),
      });
    });
    const successRate: SuccessRateData[] = Array.from(
      successBySlot.entries()
    ).map(([date, counts]) => ({
      date,
      success: counts.success,
      error: counts.error,
    }));

    // Calculate totals
    const totalInputTokens = logs.reduce((sum, log) => sum + log.inputTokens, 0);
    const totalOutputTokens = logs.reduce((sum, log) => sum + log.outputTokens, 0);
    const durationValues = logs
      .map((log) => log.duration)
      .filter((duration): duration is number => duration !== null)
      .sort((a, b) => a - b);
    const avgDuration =
      durationValues.length > 0
        ? Math.round(
            durationValues.reduce((sum, duration) => sum + duration, 0) /
              durationValues.length
          )
        : 0;
    const durationPercentiles = calculateDurationPercentiles(durationValues);
    const successfulRequests = logs.filter(
      (log) => log.statusCode !== null && log.statusCode >= 200 && log.statusCode < 400
    ).length;
    const successRatePercent =
      totalRequests > 0 ? Math.round((successfulRequests / totalRequests) * 100) : 0;

    const totals: AnalyticsTotals = {
      totalRequests,
      totalInputTokens,
      totalOutputTokens,
      avgDuration,
      durationPercentiles,
      successRate: successRatePercent,
    };

    return {
      success: true,
      data: {
        requestsOverTime,
        tokenUsage,
        requestsByModel,
        modelDistribution,
        successRate,
        durationOverTime,
        granularity: config.granularity,
        totals,
      },
    };
  } catch (error) {
    console.error("Failed to fetch analytics:", error);
    return { success: false, error: "Failed to fetch analytics data" };
  }
}
