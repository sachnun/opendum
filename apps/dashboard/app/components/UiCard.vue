<script setup lang="ts">
import { cn } from "../../lib/utils";

withDefaults(
  defineProps<{
    class?: string;
  }>(),
  {
    class: "",
  }
);
</script>

<template>
  <div :class="cn('flex flex-col gap-6 rounded-xl border bg-card py-6 text-card-foreground shadow-sm', $props.class)">
    <slot />
  </div>
</template>
