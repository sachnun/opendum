<script setup lang="ts">
definePageMeta({ middleware: "auth", layout: "dashboard" });

const dashboardApi = useDashboardApi();

type ApiKeyListItem = Awaited<ReturnType<typeof dashboardApi.apiKeys.list>>[number];
type ApiKeyOptions = Awaited<ReturnType<typeof dashboardApi.apiKeys.options>>;
type AccessMode = "all" | "whitelist" | "blacklist";
type RateLimitRule = ApiKeyOptions["rateLimitsByKeyId"][string][number];

const { data, error, refresh } = await useAsyncData("dashboard-api-keys", async () => {
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

function keyRateLimits(apiKeyId: string) {
  return options.value?.rateLimitsByKeyId[apiKeyId] ?? [];
}

function accessModeLabel(mode: string) {
  const normalizedMode = mode === "whitelist" || mode === "blacklist" ? mode : "all";
  if (normalizedMode === "whitelist") return "Whitelist";
  if (normalizedMode === "blacklist") return "Blacklist";
  return "All";
}

function updateApiKeyActive(apiKeyId: string, isActive: boolean) {
  if (!data.value) return;
  data.value = {
    ...data.value,
    apiKeys: data.value.apiKeys.map((apiKey) => (apiKey.id === apiKeyId ? { ...apiKey, isActive } : apiKey)),
  };
}

function updateApiKeyModelAccess(apiKeyId: string, value: { mode: AccessMode; models: string[] }) {
  if (!data.value) return;
  data.value = {
    ...data.value,
    apiKeys: data.value.apiKeys.map((apiKey) => (apiKey.id === apiKeyId ? { ...apiKey, modelAccessMode: value.mode, modelAccessList: value.models } : apiKey)),
  };
}

function updateApiKeyAccountAccess(apiKeyId: string, value: { mode: AccessMode; accounts: string[] }) {
  if (!data.value) return;
  data.value = {
    ...data.value,
    apiKeys: data.value.apiKeys.map((apiKey) => (apiKey.id === apiKeyId ? { ...apiKey, accountAccessMode: value.mode, accountAccessList: value.accounts } : apiKey)),
  };
}

function updateApiKeyRateLimits(apiKeyId: string, rules: RateLimitRule[]) {
  if (!data.value) return;
  data.value = {
    ...data.value,
    options: {
      ...data.value.options,
      rateLimitsByKeyId: {
        ...data.value.options.rateLimitsByKeyId,
        [apiKeyId]: rules,
      },
    },
  };
}
</script>

<template>
  <div class="space-y-6">
    <div class="dashboard-header-divider">
      <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="text-xl font-semibold">API Keys</h2>
          <UiBadge variant="outline" class="tabular-nums">{{ activeApiKeyCount }}/{{ apiKeys.length }}</UiBadge>
        </div>
        <CreateApiKeyButton trigger-class="flex-1 sm:w-auto sm:flex-none" @created="refresh" />
      </div>
    </div>

    <DashboardDataNotice :error="error" />
    <section v-if="apiKeys.length === 0" class="scroll-mt-24 space-y-4 md:space-y-2">
      <div class="space-y-3 pt-1">
        <p class="text-sm text-muted-foreground">No API keys created yet.</p>
        <CreateApiKeyButton @created="refresh" />
      </div>
    </section>

    <section v-else class="scroll-mt-24 space-y-4 md:space-y-2">
      <div class="grid gap-3 grid-cols-[repeat(auto-fill,minmax(320px,1fr))]">
        <UiCard
          v-for="apiKey in apiKeys"
          :key="apiKey.id"
          class="flex h-full flex-col bg-transparent transition-colors"
          :class="getApiKeyStatus(apiKey).label !== 'Active' ? 'opacity-65' : ''"
        >
          <UiCardHeader class="pb-1">
            <div class="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
              <div class="min-w-0 overflow-hidden">
                <EditableApiKeyName :id="apiKey.id" :name="apiKey.name" :show-edit-button="false" @updated="refresh" />
              </div>
              <div class="flex h-7 shrink-0 items-center justify-end">
                <UiBadge :variant="getApiKeyStatus(apiKey).variant" class="min-w-16 justify-center text-xs">
                  {{ getApiKeyStatus(apiKey).label }}
                </UiBadge>
              </div>
            </div>
            <div class="mt-1 flex flex-wrap items-center gap-1.5">
              <UiBadge variant="outline" class="text-[10px] font-normal">Models: {{ accessModeLabel(apiKey.modelAccessMode) }}</UiBadge>
              <UiBadge variant="outline" class="text-[10px] font-normal">Accounts: {{ accessModeLabel(apiKey.accountAccessMode) }}</UiBadge>
              <UiBadge v-if="keyRateLimits(apiKey.id).length > 0" variant="outline" class="text-[10px] font-normal">
                {{ keyRateLimits(apiKey.id).length }} limit{{ keyRateLimits(apiKey.id).length === 1 ? '' : 's' }}
              </UiBadge>
            </div>
          </UiCardHeader>

          <UiCardContent class="flex flex-1 flex-col pt-0">
            <div class="flex-1 space-y-3 text-sm">
              <ApiKeyActions :api-key="apiKey" @changed="refresh" @toggled="updateApiKeyActive(apiKey.id, $event)" />

              <div class="space-y-2">
                <div class="flex justify-between gap-4">
                  <span class="text-muted-foreground">Created</span>
                  <span class="text-right font-medium">{{ apiKey.createdAt ? new Date(apiKey.createdAt).toLocaleDateString() : '-' }}</span>
                </div>
                <div class="flex items-center justify-between gap-4">
                  <span class="text-muted-foreground">Expiration</span>
                  <div class="text-right">
                    <ApiKeyExpiration :api-key-id="apiKey.id" :initial-expires-at="apiKey.expiresAt" @updated="refresh" />
                  </div>
                </div>
                <div class="flex justify-between gap-4">
                  <span class="text-muted-foreground">Last used</span>
                  <span class="text-right font-medium">{{ apiKey.lastUsedAt ? formatRelativeTime(apiKey.lastUsedAt) : '-' }}</span>
                </div>
                <NuxtLink
                  :to="`/dashboard/analistik/${apiKey.id}`"
                  class="flex justify-between gap-4 rounded-sm py-0.5 transition-colors hover:bg-muted/30"
                  title="View analytics"
                >
                  <span class="text-muted-foreground">Analytics</span>
                  <span class="text-right font-medium">Open details</span>
                </NuxtLink>
              </div>

              <div class="grid gap-2.5 border-t border-border/60 pt-3">
                <ApiKeyAccessSection title="Model Access">
                  <ApiKeyModelAccess
                    :api-key-id="apiKey.id"
                    :available-models="options?.availableModels ?? []"
                    :initial-mode="normalizeModelAccessMode(apiKey.modelAccessMode)"
                    :initial-models="apiKey.modelAccessList"
                    @updated="updateApiKeyModelAccess(apiKey.id, $event)"
                  />
                </ApiKeyAccessSection>

                <ApiKeyAccessSection title="Account Access">
                  <ApiKeyAccountAccess
                    :api-key-id="apiKey.id"
                    :available-accounts="options?.providerAccounts ?? []"
                    :initial-mode="normalizeAccountAccessMode(apiKey.accountAccessMode)"
                    :initial-accounts="apiKey.accountAccessList"
                    @updated="updateApiKeyAccountAccess(apiKey.id, $event)"
                  />
                </ApiKeyAccessSection>

                <ApiKeyAccessSection title="Rate Limits">
                  <ApiKeyRateLimit
                    :api-key-id="apiKey.id"
                    :available-models="options?.availableModels ?? []"
                    :available-families="options?.availableFamilies ?? []"
                    :initial-rules="keyRateLimits(apiKey.id)"
                    @updated="updateApiKeyRateLimits(apiKey.id, $event)"
                  />
                </ApiKeyAccessSection>
              </div>
            </div>
          </UiCardContent>
        </UiCard>
      </div>
    </section>
  </div>
</template>
