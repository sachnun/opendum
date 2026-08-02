import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { ProviderAccountDefinition, ProviderAccountKey } from "../lib/provider-accounts";
import { getProviderAccountPath } from "../lib/provider-accounts";
import type { AccountOverviewData } from "../lib/dashboard-api-types";
import { useDashboardAudit } from "../hooks/useDashboardAudit";
import { ProviderPinButton } from "./ProviderPinButton";
import { UsageStatMetric } from "./UsageStatMetric";
import { UsageSparkline } from "./UsageSparkline";
import { UiBadge } from "./ui/UiBadge";
import { UiCardContent, UiCardTitle } from "./ui/UiCard";

type ProviderOverview = AccountOverviewData["summaries"][ProviderAccountKey];
type StatDeltaTone = "positive" | "negative" | "neutral";

interface StatMetric {
  key: string;
  label: string;
  value: string;
  numericValue: number;
  formatDelta: (delta: number) => string;
  getTone?: (delta: number) => StatDeltaTone;
}

function indicatorBadge(indicator: string) {
  if (indicator === "error") return { label: "Issue", class: "border-destructive/60 text-destructive" };
  if (indicator === "warning") return { label: "Unhealty", class: "border-yellow-500 text-yellow-600" };
  return { label: "Healthy", class: "border-green-500 text-green-600" };
}

function formatDuration(duration: number | null): string {
  if (duration === null) return "-";
  if (duration >= 1000) return `${(duration / 1000).toFixed(2)}s`;
  return `${duration}ms`;
}

function compactNumber(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return n.toLocaleString();
}

function formatSignedInteger(delta: number): string {
  return `${delta > 0 ? "+" : "-"} ${compactNumber(Math.abs(Math.round(delta)))}`;
}

function formatSignedDuration(delta: number): string {
  return `${delta > 0 ? "+" : "-"} ${formatDuration(Math.abs(Math.round(delta)))}`;
}

function formatSignedPercent(delta: number): string {
  return `${delta > 0 ? "+" : "-"} ${(Math.round(Math.abs(delta) * 10) / 10)}%`;
}

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

function expandDailyPoints(points: Array<{ date: string; count: number }>) {
  const valuesByDate = new Map(points.map((point) => [point.date, point.count]));
  return buildDayKeys(30).map((date) => ({ date, count: valuesByDate.get(date) ?? 0 }));
}

function expandDurationPoints(points: Array<{ time: string; avgDuration: number }>) {
  const valuesByTime = new Map(points.map((point) => [point.time, point.avgDuration]));
  return buildHourKeys(24).map((time) => ({ time, avgDuration: valuesByTime.get(time) ?? null }));
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

export interface ProviderOverviewCardProps {
  provider: ProviderAccountDefinition;
  summary: ProviderOverview;
  pinned: boolean;
  readonly?: boolean;
  onToggled?: (providerKey: ProviderAccountKey, pinned: boolean) => void;
}

export function ProviderOverviewCard({ provider, summary, pinned, readonly, onToggled }: ProviderOverviewCardProps) {
  const { auditUser, isAuditMode, auditRefreshVersion } = useDashboardAudit();
  const [statHitEffects, setStatHitEffects] = useState<Record<string, { text: string; tone: StatDeltaTone; version: number }>>({});
  const previousStatValues = useRef<Record<string, number> | null>(null);
  const previousContextKey = useRef<string | null>(null);

  const statMetrics: StatMetric[] = [
    { key: "totalRequests", label: "Requests", value: summary.stats.totalRequests.toLocaleString(), numericValue: summary.stats.totalRequests, formatDelta: formatSignedInteger },
    { key: "totalTokens", label: "Token", value: compactNumber(summary.stats.totalTokens), numericValue: summary.stats.totalTokens, formatDelta: formatSignedInteger },
    { key: "successRate", label: "Success", value: summary.stats.successRate === null ? "-" : `${summary.stats.successRate}%`, numericValue: summary.stats.successRate ?? Number.NaN, formatDelta: formatSignedPercent },
    { key: "avgDuration", label: "Latency", value: formatDuration(summary.stats.avgDurationLastDay), numericValue: summary.stats.avgDurationLastDay ?? Number.NaN, formatDelta: formatSignedDuration, getTone: (delta) => (delta > 0 ? "negative" : "positive") },
  ];

  const contextKey = `${provider.key}:${isAuditMode ? `audit:${auditUser?.id ?? ""}` : "self"}:${auditRefreshVersion}`;

  useEffect(() => {
    const nextValues: Record<string, number> = {};
    for (const item of statMetrics) {
      if (Number.isFinite(item.numericValue)) nextValues[item.key] = item.numericValue;
    }
    if (previousContextKey.current !== contextKey) {
      previousStatValues.current = nextValues;
      previousContextKey.current = contextKey;
      setStatHitEffects({});
      return;
    }
    const previousValues = previousStatValues.current;
    if (!previousValues) {
      previousStatValues.current = nextValues;
      return;
    }
    const nextHitEffects = { ...statHitEffects };
    for (const item of statMetrics) {
      const currentValue = nextValues[item.key];
      const previousValue = previousValues[item.key];
      if (currentValue === undefined || previousValue === undefined) continue;
      const delta = currentValue - previousValue;
      if (!Number.isFinite(delta) || Math.abs(delta) < 0.0001) continue;
      nextHitEffects[item.key] = {
        text: item.formatDelta(delta),
        tone: item.getTone?.(delta) ?? (delta > 0 ? "positive" : "negative"),
        version: (nextHitEffects[item.key]?.version ?? 0) + 1,
      };
    }
    previousStatValues.current = nextValues;
    previousContextKey.current = contextKey;
    setStatHitEffects(nextHitEffects);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary]);

  const dailyPoints = expandDailyPoints(summary.stats.dailyRequests);
  const dailyValues = dailyPoints.map((point) => point.count);
  const durationPoints = expandDurationPoints(summary.stats.durationLast24Hours);
  const durationValues = durationPoints.map((point) => point.avgDuration ?? 0);
  const tickCount = Math.min(5, durationPoints.length);
  const indexes = Array.from(new Set(Array.from({ length: tickCount }, (_, index) => Math.round((index / (tickCount - 1 || 1)) * (durationPoints.length - 1)))));
  const durationLabelPoints = indexes.map((index) => durationPoints[index]).filter(Boolean) as Array<{ time: string; avgDuration: number | null }>;
  const badge = summary.active > 0 ? indicatorBadge(summary.indicator) : null;

  return (
    <div className="group relative h-full gap-3 rounded-xl border border-transparent bg-transparent p-0 shadow-none transition-colors">
      <Link to={getProviderAccountPath(provider.key)} className="absolute inset-0 z-10 rounded-lg outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50" aria-label={`Open ${provider.label} accounts`} />

      <div className="pointer-events-none relative z-20 flex items-start justify-between gap-2">
        <div className="flex items-center gap-1">
          <ProviderPinButton className="pointer-events-auto" providerKey={provider.key} pinned={pinned} readonly={readonly} onToggled={onToggled} />
          <UiCardTitle className="text-base">{provider.label}</UiCardTitle>
          {summary.connected > 0 ? <UiBadge variant="outline" className="text-xs">{summary.active}/{summary.connected}</UiBadge> : null}
        </div>
        {badge ? <UiBadge variant="outline" className={badge.class}>{badge.label}</UiBadge> : null}
      </div>

      <UiCardContent className="pointer-events-none relative z-20 p-0">
        <div className="space-y-2 rounded-md border border-border/70 p-2.5 transition-colors group-hover:border-border">
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)_minmax(0,1fr)_minmax(0,1fr)] gap-1.5">
            {statMetrics.map((stat) => (
              <UsageStatMetric
                key={stat.key}
                label={stat.label}
                value={stat.value}
                delta={statHitEffects[stat.key]?.text}
                deltaKey={statHitEffects[stat.key]?.version}
                deltaTone={statHitEffects[stat.key]?.tone}
              />
            ))}
          </div>
          <div>
            <UsageSparkline values={durationValues} color="var(--chart-2)" ariaLabel={`Average duration trend for ${provider.label} over last 24 hours`} className="h-6" height={24} />
            <div className="mt-0.5 grid grid-cols-5 text-[9px]">
              {durationLabelPoints.map((point) => (
                <span key={point.time} className={isPreviousDayLabel(point.time) ? "truncate text-center text-muted-foreground" : "truncate text-center text-foreground/80"}>{formatHourLabel(point.time)}</span>
              ))}
            </div>
          </div>
          <UsageSparkline values={dailyValues} color="var(--chart-1)" ariaLabel={`Requests trend for ${provider.label}`} />
        </div>
      </UiCardContent>
    </div>
  );
}
