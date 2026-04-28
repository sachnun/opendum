<script setup lang="ts">
defineProps<{
  error?: unknown;
}>();
</script>

<template>
  <div
    v-if="error"
    class="relative w-full rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground"
    role="alert"
  >
    <div class="flex gap-3">
      <UIcon name="i-lucide-triangle-alert" class="mt-0.5 size-4 shrink-0 text-yellow-500" />
      <div>
        <p class="font-medium text-foreground">Live data is unavailable</p>
        <p class="mt-1 text-muted-foreground">The Nuxt UI is ready, but the matching tRPC procedure or endpoint is not available yet.</p>
      </div>
    </div>
  </div>
</template>
