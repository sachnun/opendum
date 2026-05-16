<script setup lang="ts">
import { ProgressIndicator, ProgressRoot } from "reka-ui";
import { cn } from "../../lib/utils";

const props = withDefaults(
  defineProps<{
    startedAtMs?: number;
    durationMs?: number;
    active?: boolean;
    refreshing?: boolean;
    class?: string | string[];
  }>(),
  {
    startedAtMs: 0,
    durationMs: 30_000,
    active: false,
    refreshing: false,
    class: "",
  }
);

const nowMs = ref(Date.now());
const radius = 11;
const circumference = 2 * Math.PI * radius;
let progressTimer: ReturnType<typeof setInterval> | null = null;

const safeDurationMs = computed(() => Math.max(1, props.durationMs));
const elapsedMs = computed(() => props.active ? Math.max(0, nowMs.value - props.startedAtMs) : 0);
const remainingMs = computed(() => props.active ? Math.max(0, safeDurationMs.value - elapsedMs.value) : 0);
const remainingPercent = computed(() => props.active ? Math.max(0, Math.min(100, (remainingMs.value / safeDurationMs.value) * 100)) : 0);
const remainingSeconds = computed(() => Math.ceil(remainingMs.value / 1000));
const strokeDashoffset = computed(() => circumference * (1 - remainingPercent.value / 100));
const tooltipText = computed(() => {
  if (props.refreshing) return "Refreshing provider accounts";
  if (!props.active) return "Provider account polling paused";
  if (remainingSeconds.value <= 0) return "Refreshing soon";

  return `Polling ulang dalam ${remainingSeconds.value} detik`;
});

function getProgressText() {
  return tooltipText.value;
}

onMounted(() => {
  nowMs.value = Date.now();
  progressTimer = setInterval(() => {
    nowMs.value = Date.now();
  }, 250);
});

onBeforeUnmount(() => {
  if (progressTimer) clearInterval(progressTimer);
});
</script>

<template>
  <UiTooltip :text="tooltipText">
    <ProgressRoot
      :model-value="remainingPercent"
      :max="100"
      :get-value-label="getProgressText"
      :get-value-text="getProgressText"
      :class="cn(
        'relative inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground',
        props.class,
      )"
    >
      <svg class="absolute inset-0 size-8 -rotate-90" viewBox="0 0 32 32" aria-hidden="true">
        <circle cx="16" cy="16" r="11" fill="none" stroke-width="2.5" class="stroke-muted/70" />
        <circle
          cx="16"
          cy="16"
          r="11"
          fill="none"
          stroke-linecap="round"
          stroke-width="2.5"
          :class="[
            'stroke-muted-foreground/50 transition-[stroke-dashoffset] duration-300 ease-linear motion-reduce:transition-none',
            refreshing ? 'opacity-80' : 'opacity-60',
          ]"
          :style="{
            strokeDasharray: `${circumference}`,
            strokeDashoffset: `${strokeDashoffset}`,
          }"
        />
      </svg>
      <ProgressIndicator class="sr-only" />
      <span :class="['relative size-1.5 rounded-full bg-muted-foreground/45', refreshing ? 'animate-pulse' : '']" aria-hidden="true" />
    </ProgressRoot>
  </UiTooltip>
</template>
