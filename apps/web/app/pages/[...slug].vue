<script setup lang="ts">
import { parentRoute } from "~~/lib/routes";

definePageMeta({
  layout: false,
  middleware: [
    (to) => navigateTo({ path: parentRoute(to.path), query: to.query, hash: to.hash }, { replace: true }),
  ],
});
</script>

<template><div /></template>
