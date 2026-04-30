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

function shortModelName(model: string): string {
  const name = model.split("/").pop() ?? model;
  return name.length > 22 ? `${name.slice(0, 22)}...` : name;
}
</script>

<template>
  <AnalyticsChartCard title="Requests by Model">
    <AnalyticsEmptyChart v-if="!hasData" />
    <div v-else class="flex h-[230px] flex-col justify-center gap-3 sm:h-[250px]">
      <div v-for="(item, index) in data" :key="item.model" class="grid grid-cols-[6.5rem_minmax(0,1fr)_3rem] items-center gap-3">
        <span class="truncate text-[11px] text-muted-foreground" :title="item.model">{{ shortModelName(item.model) }}</span>
        <div class="h-5 overflow-hidden rounded-r-md bg-muted/60">
          <div
            class="h-full rounded-r-md opacity-80"
            :style="{
              width: `${Math.max((item.count / maxCount) * 100, 3)}%`,
              backgroundColor: colors[index % colors.length],
            }"
          />
        </div>
        <span class="text-right text-[11px] tabular-nums text-muted-foreground">{{ item.count.toLocaleString() }}</span>
      </div>
    </div>
  </AnalyticsChartCard>
</template>
