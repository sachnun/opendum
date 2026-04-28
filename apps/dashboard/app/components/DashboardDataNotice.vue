<script setup lang="ts">
defineProps<{
  error?: unknown;
}>();
</script>

<template>
  <UAlert
    v-if="error"
    color="warning"
    variant="soft"
    icon="i-lucide-triangle-alert"
    title="Live data is unavailable"
    description="The Nuxt UI is ready, but the matching tRPC procedure or endpoint is not available yet."
  />
</template>
