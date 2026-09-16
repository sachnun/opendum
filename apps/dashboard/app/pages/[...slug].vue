<script setup lang="ts">
definePageMeta({
  layout: false,
  middleware: [
    () => navigateTo("/", { replace: true, redirectCode: 301 }),
  ],
});
</script>

<template><div /></template>
