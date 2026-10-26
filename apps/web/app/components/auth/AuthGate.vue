<script setup lang="ts">
const route = useRoute();
const { isAuthenticated } = useAuth();

const isCallback = computed(() => route.path === "/auth/callback");
</script>

<template>
  <slot v-if="isCallback" />
  <LoginScreen v-else-if="!isAuthenticated" />
  <NuxtLayout v-else>
    <slot />
  </NuxtLayout>
</template>
