<script setup lang="ts">
definePageMeta({ middleware: "auth", layout: "dashboard" });

await navigateTo("/dashboard", { replace: true });
</script>

<template>
  <div />
</template>
