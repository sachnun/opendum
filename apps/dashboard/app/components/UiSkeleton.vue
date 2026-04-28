<script setup lang="ts">
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
  <div :class="['animate-pulse rounded-md bg-muted', $props.class]" />
</template>
