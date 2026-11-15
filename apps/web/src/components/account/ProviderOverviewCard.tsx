import { For, Show, createEffect, createMemo, createSignal, on, type JSX } from "solid-js";
import { A } from "@solidjs/router";
import { accountPath } from "@opendum/providers/provider-accounts";
import type { AccountOverviewData } from "~/lib/api-types";
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
  type DurationPoint,
  type StatDeltaTone,
  type StatMetric,
} from "~/lib/account-format";
import { ProviderPinButton } from "~/components/account/ProviderPinButton";
import { UsageSparkline } from "~/components/usage/UsageSparkline";
import { UsageStatMetric } from "~/components/usage/UsageStatMetric";
import { UiBadge } from "~/components/ui/UiBadge";
import { UiCard, UiCardContent, UiCardTitle } from "~/components/ui/UiCard";

type ProviderOverview = AccountOverviewData["summaries"][string];
type StatHit = { text: string; tone: StatDeltaTone; version: number };

export interface ProviderOverviewCardProps {
  provider: { key: string; slug: string; label: string };
  summary: ProviderOverview;
  pinned: boolean;
  readonly?: boolean;
  onToggled: (providerKey: string, pinned: boolean) => void;
}

function indicatorBadge(indicator: string) {
  if (indicator === "error") return { label: "Issue", class: "border-destructive/60 text-destructive" };
  if (indicator === "warning") return { label: "Unhealthy", class: "border-yellow-500 text-yellow-600" };
  return { label: "Healthy", class: "border-green-500 text-green-600" };
}

export function ProviderOverviewCard(props: ProviderOverviewCardProps): JSX.Element {
  const [statHitEffects, setStatHitEffects] = createSignal<Record<string, StatHit>>({});
  const [previousStatValues, setPreviousStatValues] = createSignal<Record<string, number> | null>(null);
  const [previousAnimationKey, setPreviousAnimationKey] = createSignal<string | null>(null);
  const [baselineContextKey, setBaselineContextKey] = createSignal<string | null>(null);

  const duration = createMemo(() => durationPoints(props.summary.stats.durationLast24Hours));
  const durationValues = createMemo(() => duration().map((point) => point.avgDuration ?? 0));
  const dailyValues = createMemo(() => dailyPoints(props.summary.stats.dailyRequests).map((point) => point.count));
  const durationLabelPoints = createMemo(() => {
    const points = duration();
    const tickCount = Math.min(5, points.length);
    const indexes = Array.from(
      new Set(Array.from({ length: tickCount }, (_, index) => Math.round((index / (tickCount - 1 || 1)) * (points.length - 1))))
    );
    return indexes.map((index) => points[index]).filter(Boolean) as DurationPoint[];
  });

  const badge = () => (props.summary.active > 0 ? indicatorBadge(props.summary.indicator) : null);
  const connected = () => props.summary.connected > 0;
  const usageChartColor = () => (connected() ? "var(--chart-1)" : "var(--muted-foreground)");
  const chartColorAlt = () => (connected() ? "var(--chart-2)" : "var(--muted-foreground)");

  const statMetrics = createMemo<StatMetric[]>(() => [
    {
      key: "totalRequests",
      label: "Requests",
      value: props.summary.stats.totalRequests.toLocaleString(),
      numericValue: props.summary.stats.totalRequests,
      formatDelta: signedInteger,
    },
    {
      key: "totalTokens",
      label: "Token",
      value: compactNumber(props.summary.stats.totalTokens),
      numericValue: props.summary.stats.totalTokens,
      formatDelta: signedInteger,
    },
    {
      key: "successRate",
      label: "Success",
      value: props.summary.stats.successRate === null ? "-" : `${props.summary.stats.successRate}%`,
      numericValue: props.summary.stats.successRate ?? Number.NaN,
      formatDelta: signedPercent,
    },
    {
      key: "avgDuration",
      label: "Latency",
      value: formatDuration(props.summary.stats.avgDurationLastDay),
      numericValue: props.summary.stats.avgDurationLastDay ?? Number.NaN,
      formatDelta: signedDuration,
      getTone: (delta) => (delta > 0 ? "negative" : "positive"),
    },
  ]);

  const animationKey = createMemo(() => {
    const userKey = isAuditMode() ? `audit:${auditUser()?.id ?? ""}` : "self";
    return `${props.provider.key}:${userKey}:${auditState.auditRefreshVersion()}`;
  });

  const stats = createMemo(() => statMetrics().map((stat) => ({ ...stat, hit: statHitEffects()[stat.key] })));

  createEffect(
    on([statMetrics, animationKey], ([items, contextKey]) => {
      const nextValues = statValues(items);
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

  return (
    <UiCard class="group relative h-full gap-3 border-transparent bg-transparent p-0 shadow-none transition-colors">
      <A
        href={accountPath(props.provider.slug)}
        class="absolute inset-0 z-10 rounded-lg outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        aria-label={`Open ${props.provider.label} accounts`}
      />

      <div class="pointer-events-none relative z-20 flex items-start justify-between gap-2">
        <div class="flex items-center gap-1">
          <ProviderPinButton
            class="pointer-events-auto"
            providerKey={props.provider.key}
            pinned={props.pinned}
            readonly={props.readonly}
            onToggled={props.onToggled}
          />
          <UiCardTitle class="text-base">{props.provider.label}</UiCardTitle>
          <Show when={props.summary.connected > 0}>
            <UiBadge variant="outline" class="text-xs">
              {props.summary.active}/{props.summary.connected}
            </UiBadge>
          </Show>
        </div>
        <Show when={badge()}>
          {(value) => (
            <UiBadge variant="outline" class={value().class}>
              {value().label}
            </UiBadge>
          )}
        </Show>
      </div>

      <UiCardContent class="pointer-events-none relative z-20 p-0">
        <div class="space-y-2 rounded-md border border-border/70 p-2.5 transition-colors group-hover:border-border">
          <div class="grid grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)_minmax(0,1fr)_minmax(0,1fr)] gap-1.5">
            <For each={stats()}>
              {(stat) => (
                <UsageStatMetric
                  label={stat.label}
                  value={stat.value}
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
              color={chartColorAlt()}
              ariaLabel={`Average duration trend for ${props.provider.label} over last 24 hours`}
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
          <UsageSparkline values={dailyValues()} color={usageChartColor()} ariaLabel={`Requests trend for ${props.provider.label}`} />
        </div>
      </UiCardContent>
    </UiCard>
  );
}
