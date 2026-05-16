<script setup lang="ts">
definePageMeta({ middleware: "auth", layout: "dashboard" });

await navigateTo("/dashboard/codex", { replace: true });
</script>

<template>
  <div />
</template>
