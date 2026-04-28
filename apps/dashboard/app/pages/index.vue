<script setup lang="ts">
import { signIn, useSession } from "../../lib/auth-client";

const route = useRoute();
const { data: session } = await useSession(useFetch);

if (session.value?.user) {
  await navigateTo((route.query.redirect as string) || "/dashboard");
}

const loading = ref(false);

async function continueWithGoogle() {
  loading.value = true;
  await signIn.social({
    provider: "google",
    callbackURL: (route.query.redirect as string) || "/dashboard",
  });
  loading.value = false;
}
</script>

<template>
  <div class="min-h-screen bg-background text-foreground">
    <main class="mx-auto flex min-h-screen w-full max-w-6xl flex-col justify-center gap-10 px-6 py-12 lg:grid lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
      <section class="space-y-8">
        <UBadge color="neutral" variant="soft" class="w-fit">
          Your accounts, one proxy
        </UBadge>
        <div class="space-y-5">
          <h1 class="max-w-3xl text-4xl font-semibold tracking-tight sm:text-6xl">
            Route AI traffic through the accounts you already own.
          </h1>
          <p class="max-w-2xl text-base text-muted-foreground sm:text-lg">
            Manage provider accounts, API keys, model access, and request analytics from a lightweight Nuxt dashboard.
          </p>
        </div>
        <div class="flex flex-wrap gap-3">
          <UButton size="lg" :loading="loading" @click="continueWithGoogle">
            Continue with Google
          </UButton>
          <UButton to="/dashboard" size="lg" color="neutral" variant="soft">
            Open dashboard
          </UButton>
        </div>
      </section>

      <UCard class="bg-card/80">
        <div class="space-y-5">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-sm text-muted-foreground">Proxy status</p>
              <p class="text-2xl font-semibold">Ready</p>
            </div>
            <UIcon name="i-lucide-activity" class="size-8 text-muted-foreground" />
          </div>
          <div class="grid gap-3 sm:grid-cols-3">
            <div class="rounded-lg border border-border bg-muted/30 p-3">
              <p class="text-xs text-muted-foreground">Accounts</p>
              <p class="mt-1 text-xl font-semibold">Many</p>
            </div>
            <div class="rounded-lg border border-border bg-muted/30 p-3">
              <p class="text-xs text-muted-foreground">Keys</p>
              <p class="mt-1 text-xl font-semibold">Scoped</p>
            </div>
            <div class="rounded-lg border border-border bg-muted/30 p-3">
              <p class="text-xs text-muted-foreground">Models</p>
              <p class="mt-1 text-xl font-semibold">Unified</p>
            </div>
          </div>
        </div>
      </UCard>
    </main>
  </div>
</template>
