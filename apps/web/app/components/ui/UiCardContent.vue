<script setup lang="ts">
import { cn } from "#shared/utils";

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
  <div :class="cn('px-6', $props.class)">
    <slot />
  </div>
</template>
