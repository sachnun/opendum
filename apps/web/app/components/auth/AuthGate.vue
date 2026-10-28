<script setup lang="ts">
import { Routes } from "~~/lib/routes";

const route = useRoute();
const { isAuthenticated } = useAuth();

const isCallback = computed(() => route.path === Routes.authCallback);
</script>

<template>
  <slot v-if="isCallback" />
  <LoginScreen v-else-if="!isAuthenticated" />
  <NuxtLayout v-else>
    <slot />
  </NuxtLayout>
</template>
