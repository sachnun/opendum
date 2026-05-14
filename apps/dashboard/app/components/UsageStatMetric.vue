<script setup lang="ts">
import { cn } from "../../lib/utils";

const props = withDefaults(
  defineProps<{
    label: string;
    value: string | number;
    variant?: "plain" | "card";
    compact?: boolean;
  }>(),
  {
    variant: "plain",
    compact: false,
  }
);

const rootClass = computed(() => props.variant === "card" ? "rounded border border-border/60 bg-background/70 px-1.5 py-1 sm:px-2 sm:py-1.5" : "");
const valueClass = computed(() => props.compact ? "text-xs sm:text-sm" : "text-sm");
</script>

<template>
  <div :class="rootClass">
    <p class="truncate text-[10px] text-muted-foreground">{{ label }}</p>
    <p :class="cn('truncate font-semibold tabular-nums text-foreground', valueClass)">{{ value }}</p>
  </div>
</template>
