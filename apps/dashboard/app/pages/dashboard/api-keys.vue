<script setup lang="ts">
definePageMeta({ middleware: "auth", layout: "dashboard" });

const dashboardApi = useDashboardApi();
const { isAuditMode } = useDashboardAudit();
const dashboardInvalidation = useDashboardDataInvalidation();
const config = useRuntimeConfig();

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
const togglingApiKeyIds = ref(new Set<string>());
const toggleErrors = ref<Record<string, string>>({});
const roamingUpdatingIds = ref(new Set<string>());
const roamingErrors = ref<Record<string, string>>({});
const proxyBaseUrl = computed(() => {
  const proxyUrl = String(config.public.proxyUrl || "").replace(/\/$/, "");
  return `${proxyUrl}/v1`;
});
const copiedProxyBaseUrl = ref(false);
let copyProxyBaseUrlTimeout: ReturnType<typeof setTimeout> | null = null;

async function copyProxyBaseUrl() {
  try {
    await navigator.clipboard.writeText(proxyBaseUrl.value);
    copiedProxyBaseUrl.value = true;

    if (copyProxyBaseUrlTimeout) {
      clearTimeout(copyProxyBaseUrlTimeout);
    }

    copyProxyBaseUrlTimeout = setTimeout(() => {
      copiedProxyBaseUrl.value = false;
    }, 1800);
  } catch {
    console.error("Failed to copy proxy base URL");
  }
}

onBeforeUnmount(() => {
  if (copyProxyBaseUrlTimeout) {
    clearTimeout(copyProxyBaseUrlTimeout);
  }
});

function getApiKeyStatus(apiKey: ApiKeyListItem) {
  const now = new Date();

  if (apiKey.expiresAt && new Date(apiKey.expiresAt) < now) {
    return { label: "Expired", variant: "destructive" as const };
  }

  if (!apiKey.isActive) {
    return { label: "Disabled", variant: "secondary" as const };
  }

  return { label: "Active", variant: "default" as const };
}

function isApiKeyEffectivelyActive(apiKey: ApiKeyListItem) {
  return getApiKeyStatus(apiKey).label === "Active";
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

function accessModeBadge(mode: string) {
  const normalizedMode = mode === "whitelist" || mode === "blacklist" ? mode : "all";
  return normalizedMode === "all" ? undefined : normalizedMode;
}

function rateLimitBadge(apiKeyId: string) {
  const count = keyRateLimits(apiKeyId).length;
  return count > 0 ? `${count} limit${count === 1 ? "" : "s"}` : undefined;
}

function updateApiKeyState(apiKeyId: string, value: { isActive: boolean; expiresAt: string | Date | null }) {
  if (!data.value) return;
  data.value = {
    ...data.value,
    apiKeys: data.value.apiKeys.map((apiKey) => (apiKey.id === apiKeyId ? { ...apiKey, ...value } : apiKey)),
  };
}

function updateApiKeyPatch(apiKeyId: string, value: Partial<ApiKeyListItem>) {
  if (!data.value) return;
  data.value = {
    ...data.value,
    apiKeys: data.value.apiKeys.map((apiKey) => (apiKey.id === apiKeyId ? { ...apiKey, ...value } : apiKey)),
  };
  dashboardInvalidation.patchApiKey(apiKeyId, value);
}

function deleteApiKey(apiKeyId: string) {
  if (!data.value) return;
  const { [apiKeyId]: _removedRateLimits, ...rateLimitsByKeyId } = data.value.options.rateLimitsByKeyId;
  data.value = {
    ...data.value,
    apiKeys: data.value.apiKeys.filter((apiKey) => apiKey.id !== apiKeyId),
    options: {
      ...data.value.options,
      rateLimitsByKeyId,
    },
  };
  dashboardInvalidation.removeApiKey(apiKeyId);
}

async function toggleApiKey(apiKey: ApiKeyListItem) {
  if (isAuditMode.value) return;
  if (togglingApiKeyIds.value.has(apiKey.id)) return;

  const nextTogglingIds = new Set(togglingApiKeyIds.value);
  nextTogglingIds.add(apiKey.id);
  togglingApiKeyIds.value = nextTogglingIds;
  toggleErrors.value = { ...toggleErrors.value, [apiKey.id]: "" };

  try {
    const result = await dashboardApi.apiKeys.toggle({ id: apiKey.id });
    if (!result.success) throw new Error(result.error);
    updateApiKeyState(apiKey.id, { isActive: result.data.isActive, expiresAt: result.data.expiresAt });
  } catch (error) {
    toggleErrors.value = {
      ...toggleErrors.value,
      [apiKey.id]: error instanceof Error ? error.message : "Failed to toggle API key",
    };
  } finally {
    const nextTogglingIds = new Set(togglingApiKeyIds.value);
    nextTogglingIds.delete(apiKey.id);
    togglingApiKeyIds.value = nextTogglingIds;
  }
}

async function toggleRoaming(apiKey: ApiKeyListItem, enabled: boolean) {
  if (isAuditMode.value) return;
  if (roamingUpdatingIds.value.has(apiKey.id)) return;

  const nextUpdatingIds = new Set(roamingUpdatingIds.value);
  nextUpdatingIds.add(apiKey.id);
  roamingUpdatingIds.value = nextUpdatingIds;
  roamingErrors.value = { ...roamingErrors.value, [apiKey.id]: "" };

  try {
    const result = await dashboardApi.apiKeys.updateRoaming({ id: apiKey.id, enabled });
    if (!result.success) throw new Error(result.error);
    updateApiKeyPatch(apiKey.id, { roamingEnabled: result.data.roamingEnabled });
  } catch (error) {
    roamingErrors.value = {
      ...roamingErrors.value,
      [apiKey.id]: error instanceof Error ? error.message : "Failed to update roaming",
    };
  } finally {
    const nextUpdatingIds = new Set(roamingUpdatingIds.value);
    nextUpdatingIds.delete(apiKey.id);
    roamingUpdatingIds.value = nextUpdatingIds;
  }
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
          <UiBadge variant="outline">{{ activeApiKeyCount }}/{{ apiKeys.length }}</UiBadge>
        </div>
        <CreateApiKeyButton :readonly="isAuditMode" trigger-class="flex-1 sm:w-auto sm:flex-none" @created="refresh" />
      </div>
    </div>

    <DashboardDataNotice :error="error" />

    <UiCard class="bg-card">
      <UiCardContent class="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div class="min-w-0 space-y-1">
          <p class="text-sm font-medium">Proxy Base URL</p>
          <code class="block break-all text-sm text-muted-foreground">{{ proxyBaseUrl }}</code>
        </div>
        <UiButton type="button" variant="outline" class="shrink-0" @click="copyProxyBaseUrl">
          <UiIcon :name="copiedProxyBaseUrl ? 'i-lucide-check' : 'i-lucide-copy'" class="size-4" />
          {{ copiedProxyBaseUrl ? 'Copied' : 'Copy' }}
        </UiButton>
      </UiCardContent>
    </UiCard>

    <section v-if="apiKeys.length > 0" class="scroll-mt-24 space-y-4 md:space-y-2">
      <div class="dashboard-card-grid">
        <UiCard
          v-for="apiKey in apiKeys"
          :key="apiKey.id"
          class="flex h-full flex-col bg-transparent transition-colors"
          :class="getApiKeyStatus(apiKey).label !== 'Active' ? 'opacity-65' : ''"
        >
          <UiCardHeader class="pb-1">
            <div class="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
              <div class="min-w-0 overflow-hidden">
                <EditableApiKeyName :id="apiKey.id" :name="apiKey.name" :key-preview="apiKey.keyPreview" :show-edit-button="false" :readonly="isAuditMode" @updated="updateApiKeyPatch(apiKey.id, $event)" />
              </div>
              <div class="flex h-7 shrink-0 items-center justify-end gap-1.5">
                <span class="text-[11px] leading-none text-muted-foreground">{{ isApiKeyEffectivelyActive(apiKey) ? 'On' : 'Off' }}</span>
                <UiSwitch
                  :model-value="isApiKeyEffectivelyActive(apiKey)"
                  :disabled="togglingApiKeyIds.has(apiKey.id) || isAuditMode"
                  :title="isApiKeyEffectivelyActive(apiKey) ? 'Disable' : 'Enable'"
                  @update:model-value="toggleApiKey(apiKey)"
                />
              </div>
            </div>
            <p v-if="toggleErrors[apiKey.id]" class="mt-1 text-xs text-destructive">{{ toggleErrors[apiKey.id] }}</p>
          </UiCardHeader>

          <UiCardContent class="flex flex-1 flex-col pt-0">
            <div class="flex-1 space-y-3 text-sm">
              <ApiKeyActions :api-key="apiKey" :readonly="isAuditMode" @renamed="updateApiKeyPatch(apiKey.id, $event)" @deleted="deleteApiKey" />

              <div class="space-y-2 pt-2">
                <div class="flex items-center justify-between gap-4">
                  <span class="text-muted-foreground">Expiration</span>
                  <div class="text-right">
                    <ApiKeyExpiration :api-key-id="apiKey.id" :initial-expires-at="apiKey.expiresAt" :readonly="isAuditMode" @updated="updateApiKeyPatch(apiKey.id, $event)" />
                  </div>
                </div>
                <div class="flex justify-between gap-4">
                  <span class="text-muted-foreground">Last used</span>
                  <span class="text-right font-medium">{{ apiKey.lastUsedAt ? formatRelativeTime(apiKey.lastUsedAt) : '-' }}</span>
                </div>
                <div class="flex items-center justify-between gap-4">
                  <span class="flex items-center gap-1.5 text-muted-foreground">
                    Roaming
                    <UiTooltip side="top" align="start" content-class="w-64 px-2 py-1.5 text-xs leading-snug">
                      <button
                        type="button"
                        class="hidden size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground/60 outline-none transition-colors hover:text-foreground focus:outline-none focus-visible:outline-none focus-visible:ring-0 [@media(hover:hover)_and_(pointer:fine)]:inline-flex"
                        aria-label="About Roaming"
                        @click.stop
                      >
                        <UiIcon name="i-lucide-circle-question-mark" class="size-3 [stroke-width:1.5]" />
                      </button>
                      <template #content>
                        <div class="space-y-1.5">
                          <p class="font-medium text-popover-foreground">Roaming</p>
                          <p class="text-muted-foreground">If all accounts fail, this API key can use shared models. Each successful roaming request uses points.</p>
                        </div>
                      </template>
                    </UiTooltip>
                    <UiPopover :content="{ align: 'start', side: 'top', class: 'w-64 px-2 py-1.5 text-xs leading-snug' }">
                      <button
                        type="button"
                        class="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground/60 outline-none transition-colors hover:text-foreground focus:outline-none focus-visible:outline-none focus-visible:ring-0 [@media(hover:hover)_and_(pointer:fine)]:hidden"
                        aria-label="About Roaming"
                        @click.stop
                      >
                        <UiIcon name="i-lucide-circle-question-mark" class="size-3 [stroke-width:1.5]" />
                      </button>
                      <template #content>
                        <div class="space-y-1.5">
                          <p class="font-medium text-popover-foreground">Roaming</p>
                          <p class="text-muted-foreground">If all accounts fail, this API key can use shared models. Each successful roaming request uses points.</p>
                        </div>
                      </template>
                    </UiPopover>
                  </span>
                  <div class="flex items-center gap-1.5">
                    <span v-if="apiKey.roamingEnabled" class="flex items-center gap-1 text-[11px] leading-none text-foreground">
                      <UiIcon name="i-lucide-coins" class="size-3" />
                      <span class="inline-flex items-center leading-none tabular-nums">{{ apiKey.roamingPointsUsed }}</span>
                    </span>
                    <UiSwitch
                      :model-value="apiKey.roamingEnabled"
                      size="sm"
                      :title="apiKey.roamingEnabled ? 'Disable' : 'Enable'"
                      :disabled="isAuditMode || roamingUpdatingIds.has(apiKey.id)"
                      @update:model-value="toggleRoaming(apiKey, $event)"
                    />
                  </div>
                </div>
                <p v-if="roamingErrors[apiKey.id]" class="text-right text-xs text-destructive">{{ roamingErrors[apiKey.id] }}</p>
              </div>

              <div class="grid gap-2.5 border-t border-border/60 pt-3">
                <ApiKeyAccessSection title="Model Access" :badge="accessModeBadge(apiKey.modelAccessMode)">
                  <ApiKeyModelAccess
                    :api-key-id="apiKey.id"
                    :available-models="options?.availableModels ?? []"
                    :initial-mode="normalizeModelAccessMode(apiKey.modelAccessMode)"
                    :initial-models="apiKey.modelAccessList"
                    :readonly="isAuditMode"
                    @updated="updateApiKeyModelAccess(apiKey.id, $event)"
                  />
                </ApiKeyAccessSection>

                <ApiKeyAccessSection title="Account Access" :badge="accessModeBadge(apiKey.accountAccessMode)">
                  <ApiKeyAccountAccess
                    :api-key-id="apiKey.id"
                    :available-accounts="options?.providerAccounts ?? []"
                    :initial-mode="normalizeAccountAccessMode(apiKey.accountAccessMode)"
                    :initial-accounts="apiKey.accountAccessList"
                    :readonly="isAuditMode"
                    @updated="updateApiKeyAccountAccess(apiKey.id, $event)"
                  />
                </ApiKeyAccessSection>

                <ApiKeyAccessSection title="Rate Limits" :badge="rateLimitBadge(apiKey.id)">
                  <ApiKeyRateLimit
                    :api-key-id="apiKey.id"
                    :available-models="options?.availableModels ?? []"
                    :available-families="options?.availableFamilies ?? []"
                    :initial-rules="keyRateLimits(apiKey.id)"
                    :readonly="isAuditMode"
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
