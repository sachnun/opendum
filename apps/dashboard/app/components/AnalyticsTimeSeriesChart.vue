<script setup lang="ts">
type Granularity = "10s" | "1m" | "5m" | "15m" | "1h" | "1d";

interface DataPoint {
  date: string;
  [key: string]: string | number | null | undefined;
}

interface ChartSeries {
  key: string;
  label: string;
  color: string;
  dashed?: boolean;
  area?: boolean;
  suffix?: string;
}

const props = withDefaults(
  defineProps<{
    title: string;
    data: DataPoint[];
    granularity: Granularity;
    series: ChartSeries[];
    height?: number;
    maxValue?: number;
  }>(),
  {
    height: 250,
    maxValue: undefined,
  }
);

const chartWidth = 640;
const chartHeight = computed(() => props.height);
const margin = { top: 10, right: 12, bottom: 28, left: 44 };
const plotWidth = computed(() => chartWidth - margin.left - margin.right);
const plotHeight = computed(() => chartHeight.value - margin.top - margin.bottom);

function numericValue(point: DataPoint, key: string): number {
  const value = point[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

const hasData = computed(() => props.data.some((point) => props.series.some((item) => numericValue(point, item.key) > 0)));
const maxY = computed(() => {
  if (props.maxValue !== undefined) return props.maxValue;

  const values = props.data.flatMap((point) => props.series.map((item) => numericValue(point, item.key)));
  return Math.max(...values, 1);
});

function xAt(index: number): number {
  if (props.data.length <= 1) return margin.left + plotWidth.value / 2;
  return margin.left + (index / (props.data.length - 1)) * plotWidth.value;
}

function yAt(value: number): number {
  const boundedValue = Math.min(Math.max(value, 0), maxY.value);
  return margin.top + plotHeight.value - (boundedValue / maxY.value) * plotHeight.value;
}

function linePath(key: string): string {
  return props.data
    .map((point, index) => `${index === 0 ? "M" : "L"} ${xAt(index).toFixed(2)} ${yAt(numericValue(point, key)).toFixed(2)}`)
    .join(" ");
}

function areaPath(key: string): string {
  if (!props.data.length) return "";

  const line = linePath(key);
  const lastX = xAt(props.data.length - 1).toFixed(2);
  const firstX = xAt(0).toFixed(2);
  const baseline = (margin.top + plotHeight.value).toFixed(2);
  return `${line} L ${lastX} ${baseline} L ${firstX} ${baseline} Z`;
}

function formatTick(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return value;
  if (props.granularity === "1d") return `${date.getMonth() + 1}/${date.getDate()}`;
  if (props.granularity === "10s" || props.granularity === "1m") {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatValue(value: number, suffix = ""): string {
  if (suffix) return `${Math.round(value)}${suffix}`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return Math.round(value).toLocaleString();
}

const yTicks = computed(() => [0, maxY.value / 2, maxY.value]);
const xTicks = computed(() => {
  if (!props.data.length) return [] as Array<{ label: string; x: number }>;
  const tickCount = Math.min(5, props.data.length);
  const indexes = Array.from(
    new Set(Array.from({ length: tickCount }, (_, index) => Math.round((index / (tickCount - 1 || 1)) * (props.data.length - 1))))
  );
  return indexes.map((index) => ({ label: formatTick(props.data[index]?.date ?? ""), x: xAt(index) }));
});
</script>

<template>
  <AnalyticsChartCard :title="title">
    <AnalyticsEmptyChart v-if="!hasData" />
    <div v-else class="space-y-2">
      <svg class="h-[220px] w-full sm:h-[250px]" :viewBox="`0 0 ${chartWidth} ${chartHeight}`" role="img" :aria-label="title">
        <line
          v-for="tick in yTicks"
          :key="tick"
          :x1="margin.left"
          :x2="chartWidth - margin.right"
          :y1="yAt(tick)"
          :y2="yAt(tick)"
          class="stroke-border/60"
          stroke-width="1"
        />
        <text
          v-for="tick in yTicks"
          :key="`label-${tick}`"
          :x="margin.left - 8"
          :y="yAt(tick) + 4"
          text-anchor="end"
          class="fill-muted-foreground text-[11px]"
        >
          {{ formatValue(tick, series[0]?.suffix) }}
        </text>
        <g v-for="item in series" :key="item.key">
          <path v-if="item.area" :d="areaPath(item.key)" :fill="item.color" opacity="0.14" />
          <path
            :d="linePath(item.key)"
            fill="none"
            :stroke="item.color"
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            :stroke-dasharray="item.dashed ? '5 4' : undefined"
          />
        </g>
        <text
          v-for="tick in xTicks"
          :key="tick.label"
          :x="tick.x"
          :y="chartHeight - 8"
          text-anchor="middle"
          class="fill-muted-foreground text-[10px]"
        >
          {{ tick.label }}
        </text>
      </svg>
      <div v-if="series.length > 1" class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span v-for="item in series" :key="`legend-${item.key}`" class="inline-flex items-center gap-1.5">
          <span class="size-2 rounded-full" :style="{ backgroundColor: item.color }" />
          {{ item.label }}
        </span>
      </div>
    </div>
  </AnalyticsChartCard>
</template>
