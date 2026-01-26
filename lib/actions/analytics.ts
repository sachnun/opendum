"use server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";

export type Period = "7d" | "30d" | "90d";

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

export interface AnalyticsTotals {
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  avgDuration: number;
  successRate: number;
}

export interface AnalyticsData {
  requestsOverTime: RequestsOverTimeData[];
  tokenUsage: TokenUsageData[];
  requestsByModel: RequestsByModelData[];
  modelDistribution: ModelDistributionData[];
  successRate: SuccessRateData[];
  totals: AnalyticsTotals;
}

function getStartDate(period: Period): Date {
  const now = new Date();
  switch (period) {
    case "7d":
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    case "30d":
      return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    case "90d":
      return new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  }
}

function formatDate(date: Date): string {
  return date.toISOString().split("T")[0];
}

function generateDateRange(startDate: Date, endDate: Date): string[] {
  const dates: string[] = [];
  const current = new Date(startDate);
  while (current <= endDate) {
    dates.push(formatDate(current));
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

export async function getAnalyticsData(
  period: Period
): Promise<ActionResult<AnalyticsData>> {
  const session = await auth();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  const userId = session.user.id;
  const startDate = getStartDate(period);
  const endDate = new Date();

  try {
    // Fetch all logs in the period
    const logs = await prisma.usageLog.findMany({
      where: {
        userId,
        createdAt: { gte: startDate },
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

    // Generate date range for filling gaps
    const dateRange = generateDateRange(startDate, endDate);

    // Process requests over time
    const requestsByDate = new Map<string, number>();
    dateRange.forEach((date) => requestsByDate.set(date, 0));
    logs.forEach((log) => {
      const date = formatDate(log.createdAt);
      requestsByDate.set(date, (requestsByDate.get(date) || 0) + 1);
    });
    const requestsOverTime: RequestsOverTimeData[] = Array.from(
      requestsByDate.entries()
    ).map(([date, count]) => ({ date, count }));

    // Process token usage over time
    const tokensByDate = new Map<string, { input: number; output: number }>();
    dateRange.forEach((date) => tokensByDate.set(date, { input: 0, output: 0 }));
    logs.forEach((log) => {
      const date = formatDate(log.createdAt);
      const current = tokensByDate.get(date) || { input: 0, output: 0 };
      tokensByDate.set(date, {
        input: current.input + log.inputTokens,
        output: current.output + log.outputTokens,
      });
    });
    const tokenUsage: TokenUsageData[] = Array.from(tokensByDate.entries()).map(
      ([date, tokens]) => ({
        date,
        input: tokens.input,
        output: tokens.output,
      })
    );

    // Process requests by model
    const modelCounts = new Map<string, number>();
    logs.forEach((log) => {
      const model = log.model.replace("iflow/", ""); // Remove prefix for display
      modelCounts.set(model, (modelCounts.get(model) || 0) + 1);
    });
    const requestsByModel: RequestsByModelData[] = Array.from(
      modelCounts.entries()
    )
      .map(([model, count]) => ({ model, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10); // Top 10 models

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
    const successByDate = new Map<string, { success: number; error: number }>();
    dateRange.forEach((date) =>
      successByDate.set(date, { success: 0, error: 0 })
    );
    logs.forEach((log) => {
      const date = formatDate(log.createdAt);
      const current = successByDate.get(date) || { success: 0, error: 0 };
      const isSuccess = log.statusCode !== null && log.statusCode >= 200 && log.statusCode < 400;
      successByDate.set(date, {
        success: current.success + (isSuccess ? 1 : 0),
        error: current.error + (isSuccess ? 0 : 1),
      });
    });
    const successRate: SuccessRateData[] = Array.from(
      successByDate.entries()
    ).map(([date, counts]) => ({
      date,
      success: counts.success,
      error: counts.error,
    }));

    // Calculate totals
    const totalInputTokens = logs.reduce((sum, log) => sum + log.inputTokens, 0);
    const totalOutputTokens = logs.reduce((sum, log) => sum + log.outputTokens, 0);
    const validDurations = logs.filter((log) => log.duration !== null);
    const avgDuration =
      validDurations.length > 0
        ? Math.round(
            validDurations.reduce((sum, log) => sum + (log.duration || 0), 0) /
              validDurations.length
          )
        : 0;
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
        totals,
      },
    };
  } catch (error) {
    console.error("Failed to fetch analytics:", error);
    return { success: false, error: "Failed to fetch analytics data" };
  }
}
