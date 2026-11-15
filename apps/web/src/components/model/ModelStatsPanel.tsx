import { For, createEffect, createMemo, createSignal, on, type JSX } from "solid-js";
import type { ModelStats } from "@opendum/models/stats";
import { auditState, auditUser, isAuditMode } from "~/lib/audit";
import {
  compactNumber,
  dailyPoints,
  durationPoints,
  formatDuration,
  hourLabel,
  prevDay,
  signedDuration,
  signedInteger,
  signedPercent,
  statValues,
  type StatDeltaTone,
  type StatMetric,
} from "~/lib/account-format";
import { UsageSparkline } from "~/components/usage/UsageSparkline";
import { UsageStatMetric } from "~/components/usage/UsageStatMetric";

type StatHit = { text: string; tone: StatDeltaTone; version: number };

export interface ModelStatsPanelProps {
  stats: ModelStats;
  label: string;
  compact?: boolean;
  disabled?: boolean;
  animateDeltas?: boolean;
  statsMap?: Record<string, ModelStats>;
  modelId?: string;
}

export function ModelStatsPanel(props: ModelStatsPanelProps): JSX.Element {
  const resolvedStats = createMemo(() => {
    if (props.modelId && props.statsMap) {
      const mapped = props.statsMap[props.modelId];
      if (mapped) return mapped;
    }
    return props.stats;
  });

  const [statHitEffects, setStatHitEffects] = createSignal<Record<string, StatHit>>({});
  const [previousStatValues, setPreviousStatValues] = createSignal<Record<string, number> | null>(null);
  const [previousAnimationKey, setPreviousAnimationKey] = createSignal<string | null>(null);
  const [baselineContextKey, setBaselineContextKey] = createSignal<string | null>(null);

  const dailyValues = createMemo(() => dailyPoints(resolvedStats().dailyRequests).map((point) => point.count));
  const duration = createMemo(() => durationPoints(resolvedStats().durationLast24Hours));
  const durationValues = createMemo(() => duration().map((point) => point.avgDuration ?? 0));
  const usageChartColor = () => (props.disabled ? "var(--muted-foreground)" : "var(--chart-1)");
  const durationChartColor = () => (props.disabled ? "var(--muted-foreground)" : "var(--chart-2)");
  const durationLabelPoints = createMemo(() => {
    const points = duration();
    const tickCount = Math.min(5, points.length);
    const indexes = Array.from(
      new Set(Array.from({ length: tickCount }, (_, index) => Math.round((index / (tickCount - 1 || 1)) * (points.length - 1))))
    );
    return indexes.map((index) => points[index]).filter(Boolean) as Array<{ time: string; avgDuration: number | null }>;
  });

  const statMetrics = createMemo<StatMetric[]>(() => [
    {
      key: "totalRequests",
      label: "Requests",
      value: resolvedStats().totalRequests.toLocaleString(),
      numericValue: resolvedStats().totalRequests,
      formatDelta: signedInteger,
    },
    {
      key: "totalTokens",
      label: "Token",
      value: compactNumber(resolvedStats().totalTokens),
      numericValue: resolvedStats().totalTokens,
      formatDelta: signedInteger,
    },
    {
      key: "successRate",
      label: "Success",
      value: resolvedStats().successRate === null ? "-" : `${resolvedStats().successRate}%`,
      numericValue: resolvedStats().successRate ?? Number.NaN,
      formatDelta: signedPercent,
    },
    {
      key: "avgDuration",
      label: "Latency",
      value: formatDuration(resolvedStats().avgDurationLastDay),
      numericValue: resolvedStats().avgDurationLastDay ?? Number.NaN,
      formatDelta: signedDuration,
      getTone: (delta) => (delta > 0 ? "negative" : "positive"),
    },
  ]);

  const animationKey = createMemo(() => {
    const userKey = isAuditMode() ? `audit:${auditUser()?.id ?? ""}` : "self";
    return `${props.label}:${userKey}:${auditState.auditRefreshVersion()}`;
  });

  const usageStats = createMemo(() =>
    statMetrics().map((stat) => ({ ...stat, hit: props.animateDeltas === false ? undefined : statHitEffects()[stat.key] }))
  );

  createEffect(
    on([statMetrics, animationKey, () => props.animateDeltas], ([items, contextKey, animateDeltas]) => {
      const nextValues = statValues(items);

      if (animateDeltas === false) {
        setPreviousStatValues(nextValues);
        setPreviousAnimationKey(contextKey);
        setBaselineContextKey(null);
        setStatHitEffects({});
        return;
      }

      const previousValues = previousStatValues();
      const previousContextKey = previousAnimationKey();
      const contextChanged = previousContextKey !== contextKey;

      if (contextChanged) {
        setPreviousStatValues(nextValues);
        setPreviousAnimationKey(contextKey);
        setBaselineContextKey(previousContextKey === null ? null : contextKey);
        setStatHitEffects({});
        return;
      }

      if (!previousValues || baselineContextKey() === contextKey) {
        setPreviousStatValues(nextValues);
        setBaselineContextKey(null);
        return;
      }

      const nextHitEffects = { ...statHitEffects() };

      for (const item of items) {
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

      setPreviousStatValues(nextValues);
      setPreviousAnimationKey(contextKey);
      setStatHitEffects(nextHitEffects);
    })
  );

  createEffect(
    on(
      () => props.label,
      () => {
        setPreviousStatValues(statValues(statMetrics()));
        setStatHitEffects({});
      }
    )
  );

  return (
    <div class="space-y-2">
      <div class="grid grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)_minmax(0,1fr)_minmax(0,1fr)] gap-1.5">
        <For each={usageStats()}>
          {(stat) => (
            <UsageStatMetric
              label={stat.label}
              value={stat.value}
              compact={props.compact}
              delta={stat.hit?.text}
              deltaKey={stat.hit?.version}
              deltaTone={stat.hit?.tone}
            />
          )}
        </For>
      </div>

      <div>
        <UsageSparkline
          values={durationValues()}
          color={durationChartColor()}
          ariaLabel={`Average duration trend for ${props.label} over last 24 hours`}
          class="h-6"
          height={24}
        />
        <div class="mt-0.5 grid grid-cols-5 text-[9px]">
          <For each={durationLabelPoints()}>
            {(point) => (
              <span class={`truncate text-center ${prevDay(point.time) ? "text-muted-foreground" : "text-foreground/80"}`}>
                {hourLabel(point.time)}
              </span>
            )}
          </For>
        </div>
      </div>

      <UsageSparkline values={dailyValues()} color={usageChartColor()} ariaLabel={`Requests trend for ${props.label}`} />
    </div>
  );
}
