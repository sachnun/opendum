<script setup lang="ts">
import { useSession } from "../../lib/auth-client";

const { data: session } = await useSession(useFetch);
const isAuthenticated = computed(() => Boolean(session.value?.user));
</script>

<template>
  <LoginScreen v-if="!isAuthenticated" />
  <NuxtLayout v-else>
    <slot />
  </NuxtLayout>
</template>
