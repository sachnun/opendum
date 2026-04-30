<script setup lang="ts">
defineProps<{
  label: string;
  value: string | number;
  hint?: string;
  icon?: string;
}>();
</script>

<template>
  <div class="rounded-xl border border-border bg-muted/40 px-4 py-4 sm:px-5">
    <div class="flex items-start justify-between gap-4">
      <div class="min-w-0">
        <p class="text-xs font-medium text-muted-foreground">
          {{ label }}
        </p>
        <p class="mt-2 text-2xl font-bold tracking-tight tabular-nums sm:text-3xl">
          {{ value }}
        </p>
        <p v-if="hint" class="mt-1 text-xs text-muted-foreground">
          {{ hint }}
        </p>
      </div>
      <UiIcon v-if="icon" :name="icon" class="size-5 text-muted-foreground" />
    </div>
  </div>
</template>
