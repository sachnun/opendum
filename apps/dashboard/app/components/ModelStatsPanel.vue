<script setup lang="ts">
import type { ModelStats } from "../../lib/model-stats";

type StatDeltaTone = "positive" | "negative" | "neutral";
type StatHitEffect = { text: string; tone: StatDeltaTone; version: number };
type StatMetric = { key: string; label: string; value: string; numericValue: number; formatDelta: (delta: number) => string; getTone?: (delta: number) => StatDeltaTone };

const props = defineProps<{
  stats: ModelStats;
  label: string;
  compact?: boolean;
  disabled?: boolean;
  animateDeltas?: boolean;
}>();

const { auditRefreshVersion, auditUser, isAuditMode } = useDashboardAudit();
const statHitEffects = ref<Record<string, StatHitEffect>>({});
const previousStatValues = ref<Record<string, number> | null>(null);
const previousStatAnimationContextKey = ref<string | null>(null);
const pendingStatBaselineContextKey = ref<string | null>(null);

const dailyValues = computed(() => props.stats.dailyRequests.map((point) => point.count));
const durationValues = computed(() => props.stats.durationLast24Hours.map((point) => point.avgDuration ?? 0));
const usageChartColor = computed(() => props.disabled ? "var(--muted-foreground)" : "var(--chart-1)");
const durationChartColor = computed(() => props.disabled ? "var(--muted-foreground)" : "var(--chart-2)");
const durationLabelPoints = computed(() => {
  const points = props.stats.durationLast24Hours;
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

function formatSignedInteger(delta: number): string {
  const sign = delta > 0 ? "+" : "-";
  return `${sign} ${compactNumber(Math.abs(Math.round(delta)))}`;
}

function formatSignedDuration(delta: number): string {
  const sign = delta > 0 ? "+" : "-";
  return `${sign} ${formatDuration(Math.abs(Math.round(delta)))}`;
}

function formatSignedPercent(delta: number): string {
  const sign = delta > 0 ? "+" : "-";
  const value = Math.round(Math.abs(delta) * 10) / 10;
  return `${sign} ${value}%`;
}

function collectStatValues(items: StatMetric[]): Record<string, number> {
  const values: Record<string, number> = {};

  for (const item of items) {
    if (Number.isFinite(item.numericValue)) values[item.key] = item.numericValue;
  }

  return values;
}

const statMetrics = computed<StatMetric[]>(() => [
  { key: "totalRequests", label: "Requests", value: props.stats.totalRequests.toLocaleString(), numericValue: props.stats.totalRequests, formatDelta: formatSignedInteger },
  { key: "totalTokens", label: "Token", value: compactNumber(props.stats.totalTokens), numericValue: props.stats.totalTokens, formatDelta: formatSignedInteger },
  { key: "successRate", label: "Success", value: props.stats.successRate === null ? "-" : `${props.stats.successRate}%`, numericValue: props.stats.successRate ?? Number.NaN, formatDelta: formatSignedPercent },
  {
    key: "avgDuration",
    label: "Latency",
    value: formatDuration(props.stats.avgDurationLastDay),
    numericValue: props.stats.avgDurationLastDay ?? Number.NaN,
    formatDelta: formatSignedDuration,
    getTone: (delta) => delta > 0 ? "negative" : "positive",
  },
]);
const statAnimationContextKey = computed(() => {
  const userKey = isAuditMode.value ? `audit:${auditUser.value?.id ?? ""}` : "self";
  return `${props.label}:${userKey}:${auditRefreshVersion.value}`;
});
const usageStats = computed(() => statMetrics.value.map((stat) => ({ ...stat, hit: props.animateDeltas === false ? undefined : statHitEffects.value[stat.key] })));

function formatHourLabel(time: string): string {
  return new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function isPreviousDayLabel(time: string): boolean {
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return false;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return date < today;
}

watch([statMetrics, statAnimationContextKey, () => props.animateDeltas], ([items, contextKey, animateDeltas]) => {
  const nextValues = collectStatValues(items);

  if (animateDeltas === false) {
    previousStatValues.value = nextValues;
    previousStatAnimationContextKey.value = contextKey;
    pendingStatBaselineContextKey.value = null;
    statHitEffects.value = {};
    return;
  }

  const previousValues = previousStatValues.value;
  const previousContextKey = previousStatAnimationContextKey.value;
  const contextChanged = previousContextKey !== contextKey;

  if (contextChanged) {
    previousStatValues.value = nextValues;
    previousStatAnimationContextKey.value = contextKey;
    pendingStatBaselineContextKey.value = previousContextKey === null ? null : contextKey;
    statHitEffects.value = {};
    return;
  }

  if (!previousValues || pendingStatBaselineContextKey.value === contextKey) {
    previousStatValues.value = nextValues;
    pendingStatBaselineContextKey.value = null;
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
  previousStatAnimationContextKey.value = contextKey;
  statHitEffects.value = nextHitEffects;
}, { immediate: true });

watch(
  () => props.label,
  () => {
    previousStatValues.value = collectStatValues(statMetrics.value);
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
        <span v-for="point in durationLabelPoints" :key="point.time" :class="['truncate text-center', isPreviousDayLabel(point.time) ? 'text-muted-foreground' : 'text-foreground/80']">
          {{ formatHourLabel(point.time) }}
        </span>
      </div>
    </div>

    <UsageSparkline :values="dailyValues" :color="usageChartColor" :aria-label="`Requests trend for ${label}`" />
  </div>
</template>
