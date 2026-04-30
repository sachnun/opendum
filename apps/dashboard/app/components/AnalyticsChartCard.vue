<script setup lang="ts">
import { cn } from "../../lib/utils";

withDefaults(
  defineProps<{
    title: string;
    class?: string;
  }>(),
  {
    class: "",
  }
);
</script>

<template>
  <div :class="cn('rounded-xl border border-border/50 bg-card/50 py-4', $props.class)">
    <div class="px-4 pb-3 sm:px-5">
      <h4 class="text-sm font-medium text-muted-foreground">{{ title }}</h4>
    </div>
    <div class="px-4 pt-0 sm:px-5">
      <slot />
    </div>
  </div>
</template>
