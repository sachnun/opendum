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
    <div class="grid grid-cols-3 gap-1.5">
      <UsageStatMetric variant="card" label="Requests" :value="stats.totalRequests.toLocaleString()" :compact="compact" />
      <UsageStatMetric variant="card" label="Success" :value="stats.successRate === null ? '-' : `${stats.successRate}%`" :compact="compact" />
      <UsageStatMetric variant="card" label="Latency" :value="formatDuration(stats.avgDurationLastDay)" :compact="compact" />
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
