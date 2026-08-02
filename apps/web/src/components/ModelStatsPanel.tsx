import { buildDayKeys, buildEmptyModelStats, buildHourKeys, MODEL_DURATION_LOOKBACK_HOURS, MODEL_STATS_DAYS, type ModelStats } from "../lib/model-stats";
import { UsageSparkline } from "./UsageSparkline";
import { UsageStatMetric } from "./UsageStatMetric";

function compactNumber(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return n.toLocaleString();
}

function formatDuration(duration: number | null): string {
  if (duration === null) return "-";
  if (duration >= 1000) return `${(duration / 1000).toFixed(2)}s`;
  return `${duration}ms`;
}

function expandDailyPoints(points: Array<{ date: string; count: number }>) {
  const valuesByDate = new Map(points.map((point) => [point.date, point.count]));
  return buildDayKeys(MODEL_STATS_DAYS).map((date) => ({ date, count: valuesByDate.get(date) ?? 0 }));
}

function expandDurationPoints(points: Array<{ time: string; avgDuration: number }>) {
  const valuesByTime = new Map(points.map((point) => [point.time, point.avgDuration]));
  return buildHourKeys(MODEL_DURATION_LOOKBACK_HOURS).map((time) => ({ time, avgDuration: valuesByTime.get(time) ?? null }));
}

function formatHourLabel(time: string): string {
  return time.slice(11, 16);
}

function isPreviousDayLabel(time: string): boolean {
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return date < today;
}

export interface ModelStatsPanelProps {
  stats: ModelStats;
  label: string;
  disabled?: boolean;
  compact?: boolean;
  animateDeltas?: boolean;
}

export function ModelStatsPanel({ stats, label, disabled, compact }: ModelStatsPanelProps) {
  const usageStats = [
    { key: "totalRequests", label: "Requests", value: stats.totalRequests.toLocaleString() },
    { key: "totalTokens", label: "Token", value: compactNumber(stats.totalTokens) },
    { key: "successRate", label: "Success", value: stats.successRate === null ? "-" : `${stats.successRate}%` },
    { key: "avgDuration", label: "Latency", value: formatDuration(stats.avgDurationLastDay) },
  ];

  const dailyPoints = expandDailyPoints(stats.dailyRequests);
  const dailyValues = dailyPoints.map((point) => point.count);
  const durationPoints = expandDurationPoints(stats.durationLast24Hours);
  const durationValues = durationPoints.map((point) => point.avgDuration ?? 0);
  const tickCount = Math.min(5, durationPoints.length);
  const indexes = Array.from(new Set(Array.from({ length: tickCount }, (_, index) => Math.round((index / (tickCount - 1 || 1)) * (durationPoints.length - 1)))));
  const durationLabelPoints = indexes.map((index) => durationPoints[index]).filter(Boolean) as Array<{ time: string; avgDuration: number | null }>;
  const usageChartColor = disabled ? "var(--border)" : "var(--chart-1)";
  const durationChartColor = disabled ? "var(--border)" : "var(--chart-2)";

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)_minmax(0,1fr)_minmax(0,1fr)] gap-1.5">
        {usageStats.map((stat) => (
          <UsageStatMetric key={stat.key} label={stat.label} value={stat.value} compact={compact} />
        ))}
      </div>
      <div>
        <UsageSparkline values={durationValues} color={durationChartColor} ariaLabel={`Average duration trend for ${label} over last 24 hours`} className="h-6" height={24} />
        <div className="mt-0.5 grid grid-cols-5 text-[9px]">
          {durationLabelPoints.map((point) => (
            <span key={point.time} className={isPreviousDayLabel(point.time) ? "truncate text-center text-muted-foreground" : "truncate text-center text-foreground/80"}>{formatHourLabel(point.time)}</span>
          ))}
        </div>
      </div>
      <UsageSparkline values={dailyValues} color={usageChartColor} ariaLabel={`Requests trend for ${label}`} />
    </div>
  );
}

export { buildEmptyModelStats };
