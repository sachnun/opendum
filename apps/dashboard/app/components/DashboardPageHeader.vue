<script setup lang="ts">
defineProps<{
  title: string;
  description?: string;
  badge?: string;
}>();
</script>

<template>
  <div class="dashboard-header-divider">
    <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div class="min-w-0">
      <div class="flex flex-wrap items-center gap-2">
        <h2 class="text-xl font-semibold text-foreground">
          {{ title }}
        </h2>
        <UiBadge v-if="badge" variant="secondary" class="text-muted-foreground">
          {{ badge }}
        </UiBadge>
      </div>
      <p v-if="description" class="mt-1 max-w-2xl text-sm text-muted-foreground">
        {{ description }}
      </p>
    </div>
      <div v-if="$slots.actions" class="flex flex-wrap gap-2">
      <slot name="actions" />
      </div>
    </div>
  </div>
</template>
