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
  <div :class="cn('animate-pulse rounded-md bg-accent', $props.class)" />
</template>
