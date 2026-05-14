<script setup lang="ts">
import type { ProviderAccountDefinition, ProviderAccountKey } from "../../lib/provider-accounts";
import { getProviderAccountPath } from "../../lib/provider-accounts";
import type { AccountSummaryData } from "../../lib/dashboard-api-types";

type ProviderSummary = AccountSummaryData["summaries"][ProviderAccountKey];

const props = defineProps<{
  provider: ProviderAccountDefinition;
  summary: ProviderSummary;
  pinned: boolean;
}>();

const emit = defineEmits<{
  toggled: [providerKey: ProviderAccountKey, pinned: boolean];
}>();

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

function formatHourLabel(time: string): string {
  return time.slice(11, 16);
}

const dailyValues = computed(() => props.summary.stats.dailyRequests.map((point) => point.count));
const durationValues = computed(() => props.summary.stats.durationLast24Hours.map((point) => point.avgDuration ?? 0));
const durationLabelPoints = computed(() => [props.summary.stats.durationLast24Hours[0], props.summary.stats.durationLast24Hours[Math.floor(props.summary.stats.durationLast24Hours.length / 2)], props.summary.stats.durationLast24Hours[props.summary.stats.durationLast24Hours.length - 1]].filter(Boolean) as Array<{ time: string; avgDuration: number | null }>);
const badge = computed(() => indicatorBadge(props.summary.indicator, props.summary.active));
function handlePinnedToggled(providerKey: ProviderAccountKey, pinned: boolean) {
  emit("toggled", providerKey, pinned);
}
</script>

<template>
  <UiCard class="group relative h-full gap-3 border-transparent bg-transparent p-0 shadow-none transition-colors hover:bg-muted/20">
    <NuxtLink :to="getProviderAccountPath(provider.key)" class="absolute inset-0 z-10 rounded-lg outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50" :aria-label="`Open ${provider.label} accounts`" />

    <div class="pointer-events-none relative z-20 flex items-start justify-between gap-2">
      <div class="flex items-center gap-1">
        <ProviderPinButton class="pointer-events-auto" :provider-key="provider.key" :pinned="pinned" @toggled="handlePinnedToggled" />
        <UiCardTitle class="text-base">{{ provider.label }}</UiCardTitle>
        <UiBadge v-if="summary.connected > 0" variant="outline" class="text-xs tabular-nums">{{ summary.active }}/{{ summary.connected }}</UiBadge>
      </div>
      <UiBadge variant="outline" :class="badge.class">{{ badge.label }}</UiBadge>
    </div>

    <UiCardContent class="pointer-events-none relative z-20 p-0">
      <div class="space-y-2 pt-1">
        <div class="grid grid-cols-3 gap-1.5">
          <UsageStatMetric label="Requests" :value="summary.stats.totalRequests.toLocaleString()" />
          <UsageStatMetric label="Success" :value="summary.stats.successRate === null ? '-' : `${summary.stats.successRate}%`" />
          <UsageStatMetric label="Latency" :value="formatDuration(summary.stats.avgDurationLastDay)" />
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
