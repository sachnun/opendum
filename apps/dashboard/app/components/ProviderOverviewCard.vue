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

function indicatorBadge(indicator: string, connectedAccounts: number) {
  if (connectedAccounts === 0) return { label: "No Accounts", class: "" };
  if (indicator === "error") return { label: "Needs Attention", class: "border-transparent bg-destructive/60 text-white" };
  if (indicator === "warning") return { label: "Recovering", class: "border-yellow-500 text-yellow-600" };
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
const peakRequests = computed(() => Math.max(...dailyValues.value, 0));
const badge = computed(() => indicatorBadge(props.summary.indicator, props.summary.connected));
function handlePinnedToggled(providerKey: ProviderAccountKey, pinned: boolean) {
  emit("toggled", providerKey, pinned);
}
</script>

<template>
  <UiCard class="relative h-full transition-colors hover:border-primary/40">
    <div class="relative z-10 flex items-start justify-between gap-2 px-6">
      <div class="flex items-center gap-1">
        <ProviderPinButton :provider-key="provider.key" :pinned="pinned" @toggled="handlePinnedToggled" />
        <UiCardTitle class="text-base">{{ provider.label }}</UiCardTitle>
      </div>
      <UiBadge variant="outline" :class="badge.class">{{ badge.label }}</UiBadge>
    </div>

    <NuxtLink :to="getProviderAccountPath(provider.key)" class="group block h-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50" :aria-label="`Open ${provider.label} accounts`">
      <span class="absolute inset-0 z-0 rounded-xl" aria-hidden="true" />
      <UiCardHeader class="space-y-1 pb-3">
        <span class="sr-only">{{ provider.label }}</span>
      </UiCardHeader>
      <UiCardContent class="space-y-3">
        <div class="flex items-center justify-between gap-2">
          <div class="flex flex-wrap gap-2">
            <UiBadge variant="secondary">{{ summary.connected }} connected</UiBadge>
            <UiBadge variant="outline">{{ summary.active }} active</UiBadge>
          </div>
          <UiIcon name="i-lucide-arrow-right" class="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
        </div>
        <div class="space-y-2 rounded-md border border-border/70 bg-muted/20 p-2.5">
          <div class="flex items-center justify-between text-[11px] text-muted-foreground">
            <span class="inline-flex items-center gap-1"><UiIcon name="i-lucide-bar-chart-3" class="size-3" />30d</span>
            <span class="tabular-nums">{{ peakRequests.toLocaleString() }} peak</span>
          </div>
          <div class="grid grid-cols-3 gap-1.5">
            <div class="rounded border border-border/60 bg-background/70 px-2 py-1.5"><p class="truncate text-[10px] text-muted-foreground">Requests</p><p class="truncate text-sm font-semibold tabular-nums text-foreground">{{ summary.stats.totalRequests.toLocaleString() }}</p></div>
            <div class="rounded border border-border/60 bg-background/70 px-2 py-1.5"><p class="truncate text-[10px] text-muted-foreground">Success</p><p class="truncate text-sm font-semibold tabular-nums text-foreground">{{ summary.stats.successRate === null ? '-' : `${summary.stats.successRate}%` }}</p></div>
            <div class="rounded border border-border/60 bg-background/70 px-2 py-1.5"><p class="truncate text-[10px] text-muted-foreground">Latency</p><p class="truncate text-sm font-semibold tabular-nums text-foreground">{{ formatDuration(summary.stats.avgDurationLastDay) }}</p></div>
          </div>
          <div class="rounded border border-border/60 bg-background/70 px-2 py-1.5">
            <UsageSparkline :values="durationValues" color="var(--chart-2)" :aria-label="`Average duration trend for ${provider.label} over last 24 hours`" class="h-6" :height="24" />
            <div class="mt-0.5 grid grid-cols-3 text-[9px] text-muted-foreground">
              <span v-for="point in durationLabelPoints" :key="point.time" class="truncate text-center">{{ formatHourLabel(point.time) }}</span>
            </div>
          </div>
          <UsageSparkline :values="dailyValues" color="var(--chart-1)" :aria-label="`Requests trend for ${provider.label}`" />
        </div>
      </UiCardContent>
    </NuxtLink>
  </UiCard>
</template>
