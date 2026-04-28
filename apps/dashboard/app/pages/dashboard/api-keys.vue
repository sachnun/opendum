<script setup lang="ts">
definePageMeta({ middleware: "auth", layout: "dashboard" });

const { $client } = useNuxtApp();
const creating = ref(false);
const newKeyName = ref("Default key");

type ApiKeyListItem = Awaited<ReturnType<typeof $client.apiKeys.list.query>>[number];

const { data, error, pending, refresh } = await useAsyncData("dashboard-api-keys", () => $client.apiKeys.list.query());
const apiKeys = computed<ApiKeyListItem[]>(() => data.value ?? []);

async function createKey() {
  creating.value = true;
  try {
    await $client.apiKeys.create.mutate({ name: newKeyName.value });
    await refresh();
  } finally {
    creating.value = false;
  }
}

function getApiKeyStatus(apiKey: ApiKeyListItem) {
  const now = new Date();

  if (!apiKey.isActive) {
    return { label: "Disabled", variant: "secondary" as const };
  }

  if (apiKey.expiresAt && new Date(apiKey.expiresAt) < now) {
    return { label: "Expired", variant: "destructive" as const };
  }

  return { label: "Active", variant: "default" as const };
}

function formatRelativeTime(value: string | Date) {
  const date = new Date(value);
  const diffMs = Date.now() - date.getTime();
  const diffMinutes = Math.floor(diffMs / 60_000);

  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays}d ago`;

  return date.toLocaleDateString();
}
</script>

<template>
  <div class="space-y-6">
    <div class="border-b border-border pb-4">
      <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 class="text-xl font-semibold">API Keys</h2>
        <div class="flex flex-wrap gap-2">
          <input
            v-model="newKeyName"
            placeholder="Key name"
            class="h-9 w-44 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
          <UiButton :disabled="creating" @click="createKey">
            <UIcon name="i-lucide-plus" :class="['size-4', creating ? 'animate-spin' : '']" />
            Create key
          </UiButton>
        </div>
      </div>
    </div>

    <DashboardDataNotice :error="error" />
    <UiSkeleton v-if="pending" class="h-80 rounded-xl" />
    <UiCard v-else-if="apiKeys.length === 0" class="bg-card">
      <UiCardContent class="flex flex-col items-center justify-center py-12">
        <div class="mb-4 rounded-full bg-muted p-4">
          <UIcon name="i-lucide-key" class="size-8 text-muted-foreground" />
        </div>
        <h3 class="text-lg font-semibold">No API keys</h3>
        <div class="mt-4">
          <UiButton :disabled="creating" @click="createKey">
            <UIcon name="i-lucide-plus" :class="['size-4', creating ? 'animate-spin' : '']" />
            Create key
          </UiButton>
        </div>
      </UiCardContent>
    </UiCard>

    <div v-else class="grid gap-4 md:grid-cols-[repeat(auto-fill,minmax(420px,1fr))]">
      <UiCard v-for="apiKey in apiKeys" :key="apiKey.id" class="bg-card" :class="getApiKeyStatus(apiKey).label !== 'Active' ? 'opacity-70' : ''">
        <UiCardContent>
          <div class="space-y-4">
            <div class="flex flex-col gap-4">
              <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-2">
                  <h2 class="truncate text-base font-semibold">{{ apiKey.name ?? 'Untitled key' }}</h2>
                  <UiBadge v-if="getApiKeyStatus(apiKey).label !== 'Active'" :variant="getApiKeyStatus(apiKey).variant">
                    {{ getApiKeyStatus(apiKey).label }}
                  </UiBadge>
                </div>
                <p class="mt-1 font-mono text-xs text-muted-foreground">{{ apiKey.keyPreview }}</p>
              </div>

              <div class="flex w-full max-w-[540px] flex-wrap gap-2">
                <UiButton variant="outline" size="sm" disabled>
                  <UIcon name="i-lucide-copy" class="size-3.5" />
                  Copy
                </UiButton>
                <UiButton variant="outline" size="sm" disabled>
                  <UIcon name="i-lucide-eye" class="size-3.5" />
                  Reveal
                </UiButton>
                <UiButton variant="outline" size="sm" disabled>
                  <UIcon name="i-lucide-power" class="size-3.5" />
                  Toggle
                </UiButton>
              </div>
            </div>

            <div class="space-y-2.5">
              <div class="rounded-xl border border-border/70 bg-muted/20 px-4 py-1">
                <div class="flex items-center justify-between gap-4 py-3 text-sm">
                  <span class="text-muted-foreground">Created</span>
                  <span class="text-right font-medium">{{ apiKey.createdAt ? new Date(apiKey.createdAt).toLocaleDateString() : '-' }}</span>
                </div>

                <div class="border-t border-border/60" />

                <div class="flex items-center justify-between gap-4 py-3 text-sm">
                  <span class="text-muted-foreground">Expiration</span>
                  <span class="text-right font-medium">{{ apiKey.expiresAt ? new Date(apiKey.expiresAt).toLocaleDateString() : 'Never' }}</span>
                </div>

                <div class="border-t border-border/60" />

                <div class="flex items-center justify-between gap-4 py-3 text-sm">
                  <span class="text-muted-foreground">Last used</span>
                  <span class="text-right font-medium">{{ apiKey.lastUsedAt ? formatRelativeTime(apiKey.lastUsedAt) : 'Never used' }}</span>
                </div>
              </div>

              <NuxtLink
                :to="`/dashboard/analistik/${apiKey.id}`"
                class="flex items-center justify-between gap-4 rounded-xl border border-border/70 bg-muted/20 px-4 py-3 text-sm transition-colors hover:border-border hover:bg-muted/35"
                title="View analytics"
              >
                <span class="inline-flex items-center gap-1.5 text-muted-foreground">
                  <UIcon name="i-lucide-bar-chart-3" class="size-3.5" />
                  Analytics
                </span>
                <span class="text-right font-medium">Open usage details</span>
              </NuxtLink>
            </div>

            <div class="grid gap-3.5">
              <div v-for="title in ['Model Access', 'Account Access', 'Rate Limits']" :key="title" class="rounded-xl border border-border/70 bg-muted/20 lg:hidden">
                <button type="button" class="flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm font-semibold">
                  <span>{{ title }}</span>
                  <UIcon name="i-lucide-chevron-down" class="size-4 text-muted-foreground" />
                </button>
              </div>
            </div>
          </div>
        </UiCardContent>
      </UiCard>
    </div>
  </div>
</template>
