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
</script>

<template>
  <div class="space-y-6">
    <DashboardPageHeader title="API Keys" description="Create and inspect scoped proxy keys for apps and local tools.">
      <template #actions>
        <UInput v-model="newKeyName" placeholder="Key name" class="w-44" />
        <UButton :loading="creating" icon="i-lucide-plus" @click="createKey">
          Create key
        </UButton>
      </template>
    </DashboardPageHeader>

    <DashboardDataNotice :error="error" />
    <USkeleton v-if="pending" class="h-80 rounded-xl" />
    <DashboardEmptyState v-else-if="apiKeys.length === 0" title="No API keys" description="Create a key to call the proxy API." icon="i-lucide-key" />
    <div v-else class="grid gap-4 lg:grid-cols-2">
      <UCard v-for="apiKey in apiKeys" :key="apiKey.id">
        <div class="space-y-4">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <h2 class="truncate font-semibold">{{ apiKey.name ?? 'Untitled key' }}</h2>
              <p class="mt-1 font-mono text-xs text-muted-foreground">{{ apiKey.keyPreview }}</p>
            </div>
            <UBadge :color="apiKey.isActive === false ? 'neutral' : 'success'" variant="soft">
              {{ apiKey.isActive === false ? 'Disabled' : 'Active' }}
            </UBadge>
          </div>
          <div class="grid gap-3 text-sm sm:grid-cols-2">
            <div class="rounded-lg border border-border bg-muted/20 p-3">
              <p class="text-muted-foreground">Created</p>
              <p>{{ apiKey.createdAt ? new Date(apiKey.createdAt).toLocaleDateString() : '-' }}</p>
            </div>
            <div class="rounded-lg border border-border bg-muted/20 p-3">
              <p class="text-muted-foreground">Last used</p>
              <p>{{ apiKey.lastUsedAt ? new Date(apiKey.lastUsedAt).toLocaleDateString() : 'Never' }}</p>
            </div>
          </div>
          <UButton :to="`/dashboard/analistik/${apiKey.id}`" color="neutral" variant="soft" icon="i-lucide-chart-bar" block>
            View analytics
          </UButton>
        </div>
      </UCard>
    </div>
  </div>
</template>
