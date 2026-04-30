<script setup lang="ts">
import { cn } from "../../lib/utils";

const props = withDefaults(
  defineProps<{
    values: number[];
    color: string;
    ariaLabel?: string;
    class?: string;
    emptyLabel?: string;
    height?: number;
  }>(),
  {
    class: "",
    ariaLabel: "Usage trend",
    emptyLabel: "No activity yet",
    height: 32,
  }
);

const containerRef = ref<HTMLDivElement | null>(null);
const chartWidth = ref(120);
let observer: ResizeObserver | null = null;

function buildSparklinePath(values: number[], width: number, height: number): string {
  if (values.length === 0) {
    return "";
  }

  const max = Math.max(...values);
  const min = Math.min(...values);
  const step = values.length > 1 ? width / (values.length - 1) : 0;

  if (max === min) {
    const y = max === 0 ? height : height / 2;
    return values
      .map((_, index) => `${index === 0 ? "M" : "L"}${(index * step).toFixed(2)},${y.toFixed(2)}`)
      .join(" ");
  }

  const range = max - min;

  return values
    .map((value, index) => {
      const x = index * step;
      const normalized = (value - min) / range;
      const y = height - normalized * height;
      return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}

const hasUsage = computed(() => props.values.some((value) => value > 0));
const sparklinePath = computed(() => buildSparklinePath(props.values, chartWidth.value, props.height));
const areaPath = computed(() => {
  if (!sparklinePath.value) {
    return "";
  }

  return `${sparklinePath.value} L${chartWidth.value},${props.height} L0,${props.height} Z`;
});

onMounted(() => {
  const element = containerRef.value;

  if (!element) {
    return;
  }

  const updateChartWidth = () => {
    chartWidth.value = Math.max(1, Math.round(element.getBoundingClientRect().width));
  };

  updateChartWidth();
  observer = new ResizeObserver(updateChartWidth);
  observer.observe(element);
});

onBeforeUnmount(() => {
  observer?.disconnect();
});
</script>

<template>
  <div ref="containerRef" :class="cn('relative h-8 w-full', $props.class)">
    <svg :viewBox="`0 0 ${chartWidth} ${height}`" class="h-full w-full" role="img" :aria-label="ariaLabel">
      <path :d="`M0,${height} L${chartWidth},${height}`" stroke="var(--border)" stroke-width="1" fill="none" />
      <path v-if="hasUsage && areaPath" :d="areaPath" :fill="color" fill-opacity="0.18" stroke="none" />
      <path
        v-if="hasUsage && sparklinePath"
        :d="sparklinePath"
        :stroke="color"
        stroke-width="2"
        fill="none"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
    <span v-if="!hasUsage" class="pointer-events-none absolute inset-0 flex items-center justify-center text-[10px] text-muted-foreground">
      {{ emptyLabel }}
    </span>
  </div>
</template>
