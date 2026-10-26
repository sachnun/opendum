<script setup lang="ts">
import type { ModelStats } from "@opendum/models/stats";

type StatDeltaTone = "positive" | "negative" | "neutral";
type StatHit = { text: string; tone: StatDeltaTone; version: number };
type StatMetric = { key: string; label: string; value: string; numericValue: number; formatDelta: (delta: number) => string; getTone?: (delta: number) => StatDeltaTone };

const props = defineProps<{
  stats: ModelStats;
  label: string;
  compact?: boolean;
  disabled?: boolean;
  animateDeltas?: boolean;
  statsMap?: Record<string, ModelStats>;
  modelId?: string;
}>();

const resolvedStats = computed(() => {
  if (props.modelId && props.statsMap) {
    const mapped = props.statsMap[props.modelId];
    if (mapped) return mapped;
  }

  return props.stats;
});

const { auditRefreshVersion, auditUser, isAuditMode } = useAudit();
const statHitEffects = ref<Record<string, StatHit>>({});
const previousStatValues = ref<Record<string, number> | null>(null);
const previousAnimationKey = ref<string | null>(null);
const baselineContextKey = ref<string | null>(null);

function hourKeys(hours: number): string[] {
  const now = new Date();
  const currentHourUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours()));

  return Array.from({ length: hours }, (_, index) => {
    const date = new Date(currentHourUtc);
    date.setUTCHours(currentHourUtc.getUTCHours() - (hours - 1 - index));
    return date.toISOString();
  });
}

function dayKeys(days: number): string[] {
  const now = new Date();
  const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  return Array.from({ length: days }, (_, index) => {
    const date = new Date(todayUtc);
    date.setUTCDate(todayUtc.getUTCDate() - (days - 1 - index));
    return date.toISOString().split("T")[0] ?? "";
  });
}

function dailyPoints(points: Array<{ date: string; count: number }>) {
  const valuesByDate = new Map(points.map((point) => [point.date, point.count]));
  return dayKeys(30).map((date) => ({ date, count: valuesByDate.get(date) ?? 0 }));
}

function durationPoints(points: Array<{ time: string; avgDuration: number }>) {
  const valuesByTime = new Map(points.map((point) => [point.time, point.avgDuration]));
  return hourKeys(24).map((time) => ({ time, avgDuration: valuesByTime.get(time) ?? null }));
}

const daily = computed(() => dailyPoints(resolvedStats.value.dailyRequests));
const dailyValues = computed(() => daily.value.map((point) => point.count));
const duration = computed(() => durationPoints(resolvedStats.value.durationLast24Hours));
const durationValues = computed(() => duration.value.map((point) => point.avgDuration ?? 0));
const usageChartColor = computed(() => props.disabled ? "var(--muted-foreground)" : "var(--chart-1)");
const durationChartColor = computed(() => props.disabled ? "var(--muted-foreground)" : "var(--chart-2)");
const durationLabelPoints = computed(() => {
  const points = duration.value;
  const tickCount = Math.min(5, points.length);
  const indexes = Array.from(new Set(Array.from({ length: tickCount }, (_, index) => Math.round((index / (tickCount - 1 || 1)) * (points.length - 1)))));
  return indexes.map((index) => points[index]).filter(Boolean) as Array<{ time: string; avgDuration: number | null }>;
});

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

function signedInteger(delta: number): string {
  const sign = delta > 0 ? "+" : "-";
  return `${sign} ${compactNumber(Math.abs(Math.round(delta)))}`;
}

function signedDuration(delta: number): string {
  const sign = delta > 0 ? "+" : "-";
  return `${sign} ${formatDuration(Math.abs(Math.round(delta)))}`;
}

function signedPercent(delta: number): string {
  const sign = delta > 0 ? "+" : "-";
  const value = Math.round(Math.abs(delta) * 10) / 10;
  return `${sign} ${value}%`;
}

function statValues(items: StatMetric[]): Record<string, number> {
  const values: Record<string, number> = {};

  for (const item of items) {
    if (Number.isFinite(item.numericValue)) values[item.key] = item.numericValue;
  }

  return values;
}

const statMetrics = computed<StatMetric[]>(() => [
  { key: "totalRequests", label: "Requests", value: resolvedStats.value.totalRequests.toLocaleString(), numericValue: resolvedStats.value.totalRequests, formatDelta: signedInteger },
  { key: "totalTokens", label: "Token", value: compactNumber(resolvedStats.value.totalTokens), numericValue: resolvedStats.value.totalTokens, formatDelta: signedInteger },
  { key: "successRate", label: "Success", value: resolvedStats.value.successRate === null ? "-" : `${resolvedStats.value.successRate}%`, numericValue: resolvedStats.value.successRate ?? Number.NaN, formatDelta: signedPercent },
  {
    key: "avgDuration",
    label: "Latency",
    value: formatDuration(resolvedStats.value.avgDurationLastDay),
    numericValue: resolvedStats.value.avgDurationLastDay ?? Number.NaN,
    formatDelta: signedDuration,
    getTone: (delta) => delta > 0 ? "negative" : "positive",
  },
]);
const animationKey = computed(() => {
  const userKey = isAuditMode.value ? `audit:${auditUser.value?.id ?? ""}` : "self";
  return `${props.label}:${userKey}:${auditRefreshVersion.value}`;
});
const usageStats = computed(() => statMetrics.value.map((stat) => ({ ...stat, hit: props.animateDeltas === false ? undefined : statHitEffects.value[stat.key] })));

function hourLabel(time: string): string {
  return new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function prevDay(time: string): boolean {
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return false;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return date < today;
}

watch([statMetrics, animationKey, () => props.animateDeltas], ([items, contextKey, animateDeltas]) => {
  const nextValues = statValues(items);

  if (animateDeltas === false) {
    previousStatValues.value = nextValues;
    previousAnimationKey.value = contextKey;
    baselineContextKey.value = null;
    statHitEffects.value = {};
    return;
  }

  const previousValues = previousStatValues.value;
  const previousContextKey = previousAnimationKey.value;
  const contextChanged = previousContextKey !== contextKey;

  if (contextChanged) {
    previousStatValues.value = nextValues;
    previousAnimationKey.value = contextKey;
    baselineContextKey.value = previousContextKey === null ? null : contextKey;
    statHitEffects.value = {};
    return;
  }

  if (!previousValues || baselineContextKey.value === contextKey) {
    previousStatValues.value = nextValues;
    baselineContextKey.value = null;
    return;
  }

  const nextHitEffects = { ...statHitEffects.value };

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

  previousStatValues.value = nextValues;
  previousAnimationKey.value = contextKey;
  statHitEffects.value = nextHitEffects;
}, { immediate: true });

watch(
  () => props.label,
  () => {
    previousStatValues.value = statValues(statMetrics.value);
    statHitEffects.value = {};
  }
);
</script>

<template>
  <div class="space-y-2">
    <div class="grid grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)_minmax(0,1fr)_minmax(0,1fr)] gap-1.5">
      <UsageStatMetric
        v-for="stat in usageStats"
        :key="stat.key"
        :label="stat.label"
        :value="stat.value"
        :compact="compact"
        :delta="stat.hit?.text"
        :delta-key="stat.hit?.version"
        :delta-tone="stat.hit?.tone"
      />
    </div>

    <div>
      <UsageSparkline
        :values="durationValues"
        :color="durationChartColor"
        :aria-label="`Average duration trend for ${label} over last 24 hours`"
        class="h-6"
        :height="24"
      />
      <div class="mt-0.5 grid grid-cols-5 text-[9px]">
        <span v-for="point in durationLabelPoints" :key="point.time" :class="['truncate text-center', prevDay(point.time) ? 'text-muted-foreground' : 'text-foreground/80']">
          {{ hourLabel(point.time) }}
        </span>
      </div>
    </div>

    <UsageSparkline :values="dailyValues" :color="usageChartColor" :aria-label="`Requests trend for ${label}`" />
  </div>
</template>
