<script setup lang="ts">
defineProps<{
  title: string;
  description?: string;
  badge?: string;
}>();
</script>

<template>
  <div class="flex flex-col gap-4 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between">
    <div class="min-w-0 space-y-2">
      <div class="flex flex-wrap items-center gap-2">
        <h1 class="text-2xl font-semibold tracking-tight text-foreground">
          {{ title }}
        </h1>
        <UBadge v-if="badge" color="neutral" variant="soft">
          {{ badge }}
        </UBadge>
      </div>
      <p v-if="description" class="max-w-2xl text-sm text-muted-foreground">
        {{ description }}
      </p>
    </div>
    <div v-if="$slots.actions" class="flex flex-wrap gap-2">
      <slot name="actions" />
    </div>
  </div>
</template>
