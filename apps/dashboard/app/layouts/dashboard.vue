<script setup lang="ts">
import { signOut, useSession } from "../../lib/auth-client";

const route = useRoute();
const { data: session } = await useSession(useFetch);

const navigation = [
  { label: "Analytics", to: "/dashboard", icon: "i-lucide-chart-no-axes-combined" },
  { label: "Usage", to: "/dashboard/usage", icon: "i-lucide-book-open" },
  { label: "API Keys", to: "/dashboard/api-keys", icon: "i-lucide-key" },
  { label: "Accounts", to: "/dashboard/accounts", icon: "i-lucide-users" },
  { label: "Models", to: "/dashboard/models", icon: "i-lucide-cpu" },
  { label: "Playground", to: "/dashboard/playground", icon: "i-lucide-flask-conical" },
];

const mobileOpen = ref(false);

const userLabel = computed(() => session.value?.user?.name || session.value?.user?.email || "Account");

async function handleSignOut() {
  await signOut();
  await navigateTo("/");
}
</script>

<template>
  <div class="min-h-screen bg-background text-foreground">
    <aside class="fixed inset-y-0 left-0 z-40 hidden w-64 border-r border-border bg-sidebar/95 px-4 py-5 lg:block">
      <NuxtLink to="/dashboard" class="flex items-center gap-3 px-2">
        <div class="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <UIcon name="i-lucide-route" class="size-5" />
        </div>
        <div>
          <p class="text-sm font-semibold">Opendum</p>
          <p class="text-xs text-muted-foreground">Dashboard</p>
        </div>
      </NuxtLink>

      <nav class="mt-8 space-y-1">
        <NuxtLink
          v-for="item in navigation"
          :key="item.to"
          :to="item.to"
          class="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted-foreground transition hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          :class="route.path === item.to || (item.to !== '/dashboard' && route.path.startsWith(item.to)) ? 'bg-sidebar-accent text-sidebar-accent-foreground' : ''"
        >
          <UIcon :name="item.icon" class="size-4" />
          <span>{{ item.label }}</span>
        </NuxtLink>
      </nav>
    </aside>

    <div class="lg:pl-64">
      <header class="sticky top-0 z-30 border-b border-border bg-background/90 backdrop-blur">
        <div class="flex h-16 items-center justify-between gap-3 px-4 sm:px-6 lg:px-8">
          <div class="flex items-center gap-3">
            <UButton icon="i-lucide-menu" color="neutral" variant="ghost" class="lg:hidden" @click="mobileOpen = true" />
            <NuxtLink to="/dashboard" class="text-sm font-semibold lg:hidden">
              Opendum
            </NuxtLink>
          </div>
          <div class="flex items-center gap-3">
            <span class="hidden max-w-52 truncate text-sm text-muted-foreground sm:inline">{{ userLabel }}</span>
            <UButton color="neutral" variant="soft" size="sm" @click="handleSignOut">
              Sign out
            </UButton>
          </div>
        </div>
      </header>

      <main class="px-4 py-6 sm:px-6 lg:px-8">
        <slot />
      </main>
    </div>

    <USlideover v-model:open="mobileOpen" title="Navigation" side="left">
      <template #body>
        <nav class="space-y-1">
          <NuxtLink
            v-for="item in navigation"
            :key="item.to"
            :to="item.to"
            class="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground"
            :class="route.path === item.to || (item.to !== '/dashboard' && route.path.startsWith(item.to)) ? 'bg-muted text-foreground' : ''"
            @click="mobileOpen = false"
          >
            <UIcon :name="item.icon" class="size-4" />
            <span>{{ item.label }}</span>
          </NuxtLink>
        </nav>
      </template>
    </USlideover>
  </div>
</template>
