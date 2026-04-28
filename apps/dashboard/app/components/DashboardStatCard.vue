<script setup lang="ts">
defineProps<{
  label: string;
  value: string | number;
  hint?: string;
  icon?: string;
}>();
</script>

<template>
  <UCard>
    <div class="flex items-start justify-between gap-4">
      <div class="space-y-1">
        <p class="text-sm text-muted-foreground">
          {{ label }}
        </p>
        <p class="text-2xl font-semibold tabular-nums">
          {{ value }}
        </p>
        <p v-if="hint" class="text-xs text-muted-foreground">
          {{ hint }}
        </p>
      </div>
      <UIcon v-if="icon" :name="icon" class="size-5 text-muted-foreground" />
    </div>
  </UCard>
</template>
