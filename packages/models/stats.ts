export const MODEL_STATS_DAYS = 30;
export const MODEL_DURATION_LOOKBACK_HOURS = 24;

export interface ModelStats {
  totalRequests: number;
  totalTokens: number;
  successRate: number | null;
  dailyRequests: Array<{ date: string; count: number }>;
  avgDurationLastDay: number | null;
  durationLast24Hours: Array<{ time: string; avgDuration: number }>;
}

export function buildDayKeys(days: number): string[] {
  const now = new Date();
  const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  return Array.from({ length: days }, (_, index) => {
    const date = new Date(todayUtc);
    date.setUTCDate(todayUtc.getUTCDate() - (days - 1 - index));
    return date.toISOString().split("T")[0] ?? "";
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

export function buildEmptyModelStats(_dayKeys: string[], _hourKeys: string[]): ModelStats {
  return {
    totalRequests: 0,
    totalTokens: 0,
    successRate: null,
    dailyRequests: [],
    avgDurationLastDay: null,
    durationLast24Hours: [],
  };
}
