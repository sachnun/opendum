<script setup lang="ts">
import type { ModelStats } from "../../lib/model-stats";

const props = defineProps<{
  stats: ModelStats;
  label: string;
  compact?: boolean;
  disabled?: boolean;
}>();

const dailyValues = computed(() => props.stats.dailyRequests.map((point) => point.count));
const durationValues = computed(() => props.stats.durationLast24Hours.map((point) => point.avgDuration ?? 0));
const usageChartColor = computed(() => props.disabled ? "var(--muted-foreground)" : "var(--chart-1)");
const durationChartColor = computed(() => props.disabled ? "var(--muted-foreground)" : "var(--chart-2)");
const durationLabelPoints = computed(() => {
  const points = props.stats.durationLast24Hours;
  return [points[0], points[Math.floor(points.length / 2)], points[points.length - 1]].filter(Boolean) as Array<{ time: string; avgDuration: number | null }>;
});
const maxDailyRequests = computed(() => Math.max(...dailyValues.value, 0));

function formatDuration(duration: number | null): string {
  if (duration === null) return "-";
  if (duration >= 1000) return `${(duration / 1000).toFixed(2)}s`;
  return `${duration}ms`;
}

function formatHourLabel(time: string): string {
  return new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
</script>

<template>
  <div class="space-y-2 rounded-md border border-border/70 bg-muted/20 p-2 sm:p-2.5">
    <div class="flex items-center justify-between text-[11px] text-muted-foreground">
      <span class="inline-flex items-center gap-1">
        <UiIcon name="i-lucide-bar-chart-3" class="size-3 shrink-0" />
        30d
      </span>
      <span class="tabular-nums">{{ maxDailyRequests.toLocaleString() }} peak</span>
    </div>

    <div class="grid grid-cols-3 gap-1.5">
      <div class="rounded border border-border/60 bg-background/70 px-1.5 py-1 sm:px-2 sm:py-1.5">
        <p class="truncate text-[10px] text-muted-foreground">Requests</p>
        <p class="truncate font-semibold tabular-nums text-foreground" :class="compact ? 'text-xs sm:text-sm' : 'text-sm'">
          {{ stats.totalRequests.toLocaleString() }}
        </p>
      </div>
      <div class="rounded border border-border/60 bg-background/70 px-1.5 py-1 sm:px-2 sm:py-1.5">
        <p class="truncate text-[10px] text-muted-foreground">Success</p>
        <p class="truncate font-semibold tabular-nums text-foreground" :class="compact ? 'text-xs sm:text-sm' : 'text-sm'">
          {{ stats.successRate === null ? '-' : `${stats.successRate}%` }}
        </p>
      </div>
      <div class="rounded border border-border/60 bg-background/70 px-1.5 py-1 sm:px-2 sm:py-1.5">
        <p class="truncate text-[10px] text-muted-foreground">Latency</p>
        <p class="truncate font-semibold tabular-nums text-foreground" :class="compact ? 'text-xs sm:text-sm' : 'text-sm'">
          {{ formatDuration(stats.avgDurationLastDay) }}
        </p>
      </div>
    </div>

    <div class="rounded border border-border/60 bg-background/70 px-1.5 py-1 sm:px-2 sm:py-1.5">
      <UsageSparkline
        :values="durationValues"
        :color="durationChartColor"
        :aria-label="`Average duration trend for ${label} over last 24 hours`"
        class="h-6"
        :height="24"
      />
      <div class="mt-0.5 grid grid-cols-3 text-[9px] text-muted-foreground">
        <span v-for="point in durationLabelPoints" :key="point.time" class="truncate text-center">
          {{ formatHourLabel(point.time) }}
        </span>
      </div>
    </div>

    <UsageSparkline :values="dailyValues" :color="usageChartColor" :aria-label="`Requests trend for ${label}`" />
  </div>
</template>
