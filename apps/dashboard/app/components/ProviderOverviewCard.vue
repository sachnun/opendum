<script setup lang="ts">
import type { ProviderAccountDefinition, ProviderAccountKey } from "../../lib/provider-accounts";
import { getProviderAccountPath } from "../../lib/provider-accounts";
import type { AccountOverviewData } from "../../lib/dashboard-api-types";

type ProviderOverview = AccountOverviewData["summaries"][ProviderAccountKey];
type StatDeltaTone = "positive" | "negative" | "neutral";
type StatHitEffect = { text: string; tone: StatDeltaTone; version: number };
type StatMetric = { key: string; label: string; value: string; numericValue: number; formatDelta: (delta: number) => string };

const props = defineProps<{
  provider: ProviderAccountDefinition;
  summary: ProviderOverview;
  pinned: boolean;
  readonly?: boolean;
}>();

const emit = defineEmits<{
  toggled: [providerKey: ProviderAccountKey, pinned: boolean];
}>();

const statHitEffects = ref<Record<string, StatHitEffect>>({});
const previousStatValues = ref<Record<string, number> | null>(null);

function indicatorBadge(indicator: string, activeAccounts: number) {
  if (activeAccounts === 0) return { label: "No Accounts", class: "" };
  if (indicator === "error") return { label: "Issue", class: "border-transparent bg-destructive/60 text-white" };
  if (indicator === "warning") return { label: "Unhealty", class: "border-yellow-500 text-yellow-600" };
  return { label: "Healthy", class: "border-green-500 text-green-600" };
}

function formatDuration(duration: number | null): string {
  if (duration === null) return "-";
  if (duration >= 1000) return `${(duration / 1000).toFixed(2)}s`;
  return `${duration}ms`;
}

function compactNumber(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
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

function formatHourLabel(time: string): string {
  return time.slice(11, 16);
}

const dailyValues = computed(() => props.summary.stats.dailyRequests.map((point) => point.count));
const durationValues = computed(() => props.summary.stats.durationLast24Hours.map((point) => point.avgDuration ?? 0));
const durationLabelPoints = computed(() => [props.summary.stats.durationLast24Hours[0], props.summary.stats.durationLast24Hours[Math.floor(props.summary.stats.durationLast24Hours.length / 2)], props.summary.stats.durationLast24Hours[props.summary.stats.durationLast24Hours.length - 1]].filter(Boolean) as Array<{ time: string; avgDuration: number | null }>);
const badge = computed(() => indicatorBadge(props.summary.indicator, props.summary.active));
const statMetrics = computed<StatMetric[]>(() => [
  { key: "totalRequests", label: "Requests", value: props.summary.stats.totalRequests.toLocaleString(), numericValue: props.summary.stats.totalRequests, formatDelta: formatSignedInteger },
  { key: "successRate", label: "Success", value: props.summary.stats.successRate === null ? "-" : `${props.summary.stats.successRate}%`, numericValue: props.summary.stats.successRate ?? Number.NaN, formatDelta: formatSignedPercent },
  { key: "avgDuration", label: "Latency", value: formatDuration(props.summary.stats.avgDurationLastDay), numericValue: props.summary.stats.avgDurationLastDay ?? Number.NaN, formatDelta: formatSignedDuration },
]);
const stats = computed(() => statMetrics.value.map((stat) => ({ ...stat, hit: statHitEffects.value[stat.key] })));

watch(statMetrics, (items) => {
  const nextValues = collectStatValues(items);
  const previousValues = previousStatValues.value;

  if (!previousValues) {
    previousStatValues.value = nextValues;
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
      tone: delta > 0 ? "positive" : "negative",
      version: (nextHitEffects[item.key]?.version ?? 0) + 1,
    };
  }

  previousStatValues.value = nextValues;
  statHitEffects.value = nextHitEffects;
}, { immediate: true });

function handlePinnedToggled(providerKey: ProviderAccountKey, pinned: boolean) {
  emit("toggled", providerKey, pinned);
}
</script>

<template>
  <UiCard class="group relative h-full gap-3 border-transparent bg-transparent p-0 shadow-none transition-colors">
    <NuxtLink :to="getProviderAccountPath(provider.key)" class="absolute inset-0 z-10 rounded-lg outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50" :aria-label="`Open ${provider.label} accounts`" />

    <div class="pointer-events-none relative z-20 flex items-start justify-between gap-2">
      <div class="flex items-center gap-1">
        <ProviderPinButton class="pointer-events-auto" :provider-key="provider.key" :pinned="pinned" :readonly="readonly" @toggled="handlePinnedToggled" />
        <UiCardTitle class="text-base">{{ provider.label }}</UiCardTitle>
        <UiBadge v-if="summary.connected > 0" variant="outline" class="text-xs">{{ summary.active }}/{{ summary.connected }}</UiBadge>
      </div>
      <UiBadge variant="outline" :class="badge.class">{{ badge.label }}</UiBadge>
    </div>

    <UiCardContent class="pointer-events-none relative z-20 p-0">
      <div class="space-y-2 rounded-md border border-border/70 p-2.5">
        <div class="grid grid-cols-3 gap-1.5">
          <UsageStatMetric
            v-for="stat in stats"
            :key="stat.key"
            :label="stat.label"
            :value="stat.value"
            :delta="stat.hit?.text"
            :delta-key="stat.hit?.version"
            :delta-tone="stat.hit?.tone"
          />
        </div>
        <div>
          <UsageSparkline :values="durationValues" color="var(--chart-2)" :aria-label="`Average duration trend for ${provider.label} over last 24 hours`" class="h-6" :height="24" />
          <div class="mt-0.5 grid grid-cols-3 text-[9px] text-muted-foreground">
            <span v-for="point in durationLabelPoints" :key="point.time" class="truncate text-center">{{ formatHourLabel(point.time) }}</span>
          </div>
        </div>
        <UsageSparkline :values="dailyValues" color="var(--chart-1)" :aria-label="`Requests trend for ${provider.label}`" />
      </div>
    </UiCardContent>
  </UiCard>
</template>
