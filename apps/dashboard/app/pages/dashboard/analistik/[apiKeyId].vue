<script setup lang="ts">
definePageMeta({ middleware: "auth", layout: "dashboard" });

const route = useRoute();
const apiKeyId = computed(() => String(route.params.apiKeyId));
</script>

<template>
  <AnalyticsDashboard :api-key-id="apiKeyId" />
</template>
