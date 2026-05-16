<script setup lang="ts">
import { cn } from "../../lib/utils";

const props = withDefaults(
  defineProps<{
    label: string;
    value: string | number;
    variant?: "plain" | "card";
    compact?: boolean;
    delta?: string;
    deltaKey?: string | number;
    deltaTone?: "positive" | "negative" | "neutral";
  }>(),
  {
    variant: "plain",
    compact: false,
    delta: undefined,
    deltaKey: undefined,
    deltaTone: "positive",
  }
);

const rootClass = computed(() => props.variant === "card" ? "rounded border border-border/60 bg-background/70 px-1.5 py-1 sm:px-2 sm:py-1.5" : "");
const valueClass = computed(() => props.compact ? "text-xs sm:text-sm" : "text-sm");
</script>

<template>
  <div :class="rootClass">
    <p class="truncate text-[10px] text-muted-foreground">{{ label }}</p>
    <div class="relative inline-block max-w-full">
      <p :class="cn('truncate font-semibold tabular-nums text-foreground', valueClass)">{{ value }}</p>
      <span
        v-if="delta"
        :key="deltaKey"
        :class="[
          'pointer-events-none absolute left-full top-1/2 ml-1 -translate-y-1/2 whitespace-nowrap text-[10px] font-black tabular-nums animate-[stat-hit_1800ms_ease-in-out_both]',
          deltaTone === 'negative'
            ? 'text-red-500'
            : deltaTone === 'neutral'
              ? 'text-blue-500'
              : 'text-emerald-500',
        ]"
      >
        {{ delta }}
      </span>
    </div>
  </div>
</template>

<style>
@keyframes stat-hit {
  0% {
    opacity: 0;
  }

  25% {
    opacity: 1;
  }

  70% {
    opacity: 1;
  }

  100% {
    opacity: 0;
  }
}
</style>
