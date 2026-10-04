<script setup lang="ts">
const route = useRoute();

if (route.path !== "/") {
  await clearError({ redirect: "/" });
} else {
  clearError();
}
</script>

<template><div /></template>
