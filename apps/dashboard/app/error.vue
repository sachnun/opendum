<script setup lang="ts">
import type { NuxtError } from "#app";

const props = defineProps<{ error: NuxtError }>();
const statusCode = props.error.statusCode || props.error.status;

if (statusCode === 404) {
  await clearError({ redirect: "/" });
}
</script>

<template>
  <main class="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
    <section class="w-full max-w-md space-y-4 rounded-2xl border bg-card p-6 text-card-foreground shadow-sm">
      <p class="text-sm font-medium text-muted-foreground">Error {{ statusCode }}</p>
      <h1 class="text-2xl font-semibold tracking-tight">Something went wrong</h1>
      <p class="text-sm text-muted-foreground">{{ error.statusMessage || error.message || "Please try again from the home page." }}</p>
      <UiButton type="button" @click="clearError({ redirect: '/' })">Go home</UiButton>
    </section>
  </main>
</template>
