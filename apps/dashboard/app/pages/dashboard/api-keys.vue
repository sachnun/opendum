<script setup lang="ts">
definePageMeta({ middleware: "auth", layout: "dashboard" });

const dashboardApi = useDashboardApi();

type ApiKeyListItem = Awaited<ReturnType<typeof dashboardApi.apiKeys.list>>[number];
type ApiKeyOptions = Awaited<ReturnType<typeof dashboardApi.apiKeys.options>>;
type AccessMode = "all" | "whitelist" | "blacklist";

const { data, error, pending, refresh } = await useAsyncData("dashboard-api-keys", async () => {
  const [apiKeys, options] = await Promise.all([dashboardApi.apiKeys.list(), dashboardApi.apiKeys.options()]);
  return { apiKeys, options };
});

const apiKeys = computed<ApiKeyListItem[]>(() => data.value?.apiKeys ?? []);
const options = computed<ApiKeyOptions | null>(() => data.value?.options ?? null);
const activeApiKeyCount = computed(() => apiKeys.value.filter((apiKey) => getApiKeyStatus(apiKey).label === "Active").length);

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

function normalizeModelAccessMode(mode: string): AccessMode {
  return mode === "whitelist" || mode === "blacklist" ? mode : "all";
}

function normalizeAccountAccessMode(mode: string): AccessMode {
  return mode === "whitelist" || mode === "blacklist" ? mode : "all";
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

function modelAccessExpanded(apiKey: ApiKeyListItem) {
  return normalizeModelAccessMode(apiKey.modelAccessMode) !== "all" || apiKey.modelAccessList.length > 0;
}

function accountAccessExpanded(apiKey: ApiKeyListItem) {
  return normalizeAccountAccessMode(apiKey.accountAccessMode) !== "all" || apiKey.accountAccessList.length > 0;
}

function keyRateLimits(apiKeyId: string) {
  return options.value?.rateLimitsByKeyId[apiKeyId] ?? [];
}

function updateApiKeyActive(apiKeyId: string, isActive: boolean) {
  if (!data.value) return;
  data.value = {
    ...data.value,
    apiKeys: data.value.apiKeys.map((apiKey) => (apiKey.id === apiKeyId ? { ...apiKey, isActive } : apiKey)),
  };
}
</script>

<template>
  <div class="space-y-6">
    <div class="border-b border-border pb-4">
      <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="text-xl font-semibold">API Keys</h2>
          <span class="text-sm text-muted-foreground">{{ activeApiKeyCount }}/{{ apiKeys.length }}</span>
        </div>
        <CreateApiKeyButton @created="refresh" />
      </div>
    </div>

    <DashboardDataNotice :error="error" />
    <UiSkeleton v-if="pending" class="h-80 rounded-xl" />
    <UiCard v-else-if="apiKeys.length === 0" class="bg-card">
      <UiCardContent class="flex flex-col items-center justify-center py-12">
        <div class="mb-4 rounded-full bg-muted p-4">
          <UiIcon name="i-lucide-key" class="size-8 text-muted-foreground" />
        </div>
        <h3 class="text-lg font-semibold">No API keys</h3>
        <div class="mt-4">
          <CreateApiKeyButton @created="refresh" />
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
                  <EditableApiKeyName :id="apiKey.id" :name="apiKey.name" :show-edit-button="false" @updated="refresh" />
                  <UiBadge v-if="getApiKeyStatus(apiKey).label !== 'Active'" :variant="getApiKeyStatus(apiKey).variant">
                    {{ getApiKeyStatus(apiKey).label }}
                  </UiBadge>
                </div>
              </div>

              <div class="w-full max-w-[540px]">
                <ApiKeyActions :api-key="apiKey" @changed="refresh" @toggled="updateApiKeyActive(apiKey.id, $event)" />
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
                  <div class="text-right">
                    <ApiKeyExpiration :api-key-id="apiKey.id" :initial-expires-at="apiKey.expiresAt" @updated="refresh" />
                  </div>
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
                  <UiIcon name="i-lucide-bar-chart-3" class="size-3.5" />
                  Analytics
                </span>
                <span class="text-right font-medium">Open usage details</span>
              </NuxtLink>
            </div>

            <div class="grid gap-3.5">
              <ApiKeyAccessSection title="Model Access" :default-open="modelAccessExpanded(apiKey)">
                <ApiKeyModelAccess
                  :api-key-id="apiKey.id"
                  :available-models="options?.availableModels ?? []"
                  :initial-mode="normalizeModelAccessMode(apiKey.modelAccessMode)"
                  :initial-models="apiKey.modelAccessList"
                />
              </ApiKeyAccessSection>

              <ApiKeyAccessSection title="Account Access" :default-open="accountAccessExpanded(apiKey)">
                <ApiKeyAccountAccess
                  :api-key-id="apiKey.id"
                  :available-accounts="options?.providerAccounts ?? []"
                  :initial-mode="normalizeAccountAccessMode(apiKey.accountAccessMode)"
                  :initial-accounts="apiKey.accountAccessList"
                />
              </ApiKeyAccessSection>

              <ApiKeyAccessSection title="Rate Limits" :default-open="keyRateLimits(apiKey.id).length > 0">
                <ApiKeyRateLimit
                  :api-key-id="apiKey.id"
                  :available-models="options?.availableModels ?? []"
                  :available-families="options?.availableFamilies ?? []"
                  :initial-rules="keyRateLimits(apiKey.id)"
                />
              </ApiKeyAccessSection>
            </div>
          </div>
        </UiCardContent>
      </UiCard>
    </div>
  </div>
</template>
