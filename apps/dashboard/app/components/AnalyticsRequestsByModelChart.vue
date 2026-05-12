<script setup lang="ts">
interface ModelRequestPoint {
  model: string;
  count: number;
}

const props = defineProps<{
  data: ModelRequestPoint[];
}>();

const colors = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
  "var(--chart-7)",
  "var(--chart-8)",
  "var(--chart-9)",
  "var(--chart-10)",
];

const hasData = computed(() => props.data.length > 0);
const maxCount = computed(() => Math.max(...props.data.map((item) => item.count), 1));
const totalCount = computed(() => props.data.reduce((sum, item) => sum + item.count, 0));

function shortModelName(model: string): string {
  const name = model.split("/").pop() ?? model;
  return name.length > 34 ? `${name.slice(0, 34)}...` : name;
}

function percentage(count: number): number {
  return totalCount.value > 0 ? Math.round((count / totalCount.value) * 100) : 0;
}
</script>

<template>
  <AnalyticsChartCard title="Requests by Model">
    <AnalyticsEmptyChart v-if="!hasData" />
    <div v-else class="max-h-[250px] space-y-3 overflow-y-auto pr-1 [scrollbar-gutter:stable]">
      <div v-for="(item, index) in data" :key="item.model" class="space-y-1.5 rounded-lg border border-border/40 bg-muted/20 px-3 py-2">
        <div class="flex items-center justify-between gap-3 text-xs">
          <span class="min-w-0 truncate font-mono text-foreground" :title="item.model">{{ shortModelName(item.model) }}</span>
          <span class="shrink-0 tabular-nums text-muted-foreground">
            {{ item.count.toLocaleString() }} · {{ percentage(item.count) }}%
          </span>
        </div>
        <div class="h-2 overflow-hidden rounded-full bg-muted/70">
          <div
            class="h-full rounded-full opacity-85"
            :style="{
              width: `${Math.max((item.count / maxCount) * 100, 2)}%`,
              backgroundColor: colors[index % colors.length],
            }"
          />
        </div>
      </div>
    </div>
  </AnalyticsChartCard>
</template>
