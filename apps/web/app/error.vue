<script setup lang="ts">
import { parentRoute } from "~~/lib/routes";

const route = useRoute();
const parent = parentRoute(route.path);

if (parent !== route.path) {
  await clearError({ redirect: parent });
} else {
  clearError();
}
</script>

<template><div /></template>
