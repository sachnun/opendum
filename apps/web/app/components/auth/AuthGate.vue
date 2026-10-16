<script setup lang="ts">
const route = useRoute();
const { isAuthenticated } = useAuth();

const isSignInCallback = computed(() => route.path === "/auth/callback");
</script>

<template>
  <slot v-if="isSignInCallback" />
  <LoginScreen v-else-if="!isAuthenticated" />
  <NuxtLayout v-else>
    <slot />
  </NuxtLayout>
</template>
