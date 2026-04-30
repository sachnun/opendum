<script setup lang="ts">
withDefaults(
  defineProps<{
    height?: number;
  }>(),
  {
    height: 200,
  }
);
</script>

<template>
  <div
    class="flex items-center justify-center rounded-lg border border-dashed border-border/50 text-sm text-muted-foreground"
    :style="{ height: `${height}px` }"
  >
    No data yet
  </div>
</template>
