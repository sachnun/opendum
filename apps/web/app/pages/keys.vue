<script setup lang="ts">
definePageMeta({ middleware: "auth", layout: "web" });

import type { AccessMode } from "~~/lib/access-draft";
import { Effect } from "effect";
import { errorText, settle } from "~~/lib/settle";

const api = useApi();
const { isAuditMode } = useAudit();
const invalidation = useInvalidate();
const config = useRuntimeConfig();

type KeyListItem = Awaited<ReturnType<typeof api.apiKeys.list>>[number];
type ApiKeyOptions = Awaited<ReturnType<typeof api.apiKeys.options>>;
type RateLimitRule = ApiKeyOptions["rateLimitsByKeyId"][string][number];

const { data, error, refresh } = useAsyncData(dataKeys.apiKeys, async () => {
  const loaded = await Effect.runPromise(
    Effect.all([Effect.promise(() => api.apiKeys.list()), Effect.promise(() => api.apiKeys.options())])
  );
  return { apiKeys: loaded[0], options: loaded[1] };
});

const apiKeys = computed<KeyListItem[]>(() => data.value?.apiKeys ?? []);
const options = computed<ApiKeyOptions | null>(() => data.value?.options ?? null);
const activeCount = computed(() => apiKeys.value.filter((apiKey) => keyStatus(apiKey).label === "Active").length);
const togglingIds = ref(new Set<string>());
const toggleErrors = ref<Record<string, string>>({});
const roamingUpdatingIds = ref(new Set<string>());
const roamingErrors = ref<Record<string, string>>({});
const proxyBaseUrl = computed(() => {
  const apiUrl = String(config.public.apiUrl || "").replace(/\/$/, "");
  return `${apiUrl}/v1`;
});
const copiedProxy = ref(false);
let copyTimer: ReturnType<typeof setTimeout> | null = null;

async function copyProxy() {
  const copied = await settle(() => navigator.clipboard.writeText(proxyBaseUrl.value));
  if (!copied.ok) {
    console.error("Failed to copy proxy base URL");
    return;
  }
  copiedProxy.value = true;
  if (copyTimer) clearTimeout(copyTimer);
  copyTimer = setTimeout(() => {
    copiedProxy.value = false;
  }, 1800);
}

onBeforeUnmount(() => {
  if (copyTimer) {
    clearTimeout(copyTimer);
  }
});

function keyStatus(apiKey: KeyListItem) {
  const now = new Date();

  if (apiKey.expiresAt && new Date(apiKey.expiresAt) < now) {
    return { label: "Expired", variant: "destructive" as const };
  }

  if (!apiKey.isActive) {
    return { label: "Disabled", variant: "secondary" as const };
  }

  return { label: "Active", variant: "default" as const };
}

function keyActive(apiKey: KeyListItem) {
  return keyStatus(apiKey).label === "Active";
}

function accessMode(mode: string): AccessMode {
  return mode === "whitelist" || mode === "blacklist" ? mode : "all";
}

function relativeTime(value: string | Date) {
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

function limitsOf(apiKeyId: string) {
  return options.value?.rateLimitsByKeyId[apiKeyId] ?? [];
}

function accessBadge(mode: string) {
  const normalizedMode = mode === "whitelist" || mode === "blacklist" ? mode : "all";
  return normalizedMode === "all" ? undefined : normalizedMode;
}

function limitBadge(apiKeyId: string) {
  const count = limitsOf(apiKeyId).length;
  return count > 0 ? `${count} limit${count === 1 ? "" : "s"}` : undefined;
}

function formatPoints(value: number) {
  return value.toLocaleString("en-US");
}

function applyState(apiKeyId: string, value: { isActive: boolean; expiresAt: string | Date | null }) {
  if (!data.value) return;
  data.value = {
    ...data.value,
    apiKeys: data.value.apiKeys.map((apiKey) => (apiKey.id === apiKeyId ? { ...apiKey, ...value } : apiKey)),
  };
}

function applyPatch(apiKeyId: string, value: Partial<KeyListItem>) {
  if (!data.value) return;
  data.value = {
    ...data.value,
    apiKeys: data.value.apiKeys.map((apiKey) => (apiKey.id === apiKeyId ? { ...apiKey, ...value } : apiKey)),
  };
  invalidation.patchApiKey(apiKeyId, value);
}

function removeKey(apiKeyId: string) {
  if (!data.value) return;
  const { [apiKeyId]: _removedRateLimits, ...remainingRateLimits } = data.value.options.rateLimitsByKeyId;
  data.value = {
    ...data.value,
    apiKeys: data.value.apiKeys.filter((apiKey) => apiKey.id !== apiKeyId),
    options: {
      ...data.value.options,
      rateLimitsByKeyId: remainingRateLimits,
    },
  };
  invalidation.removeApiKey(apiKeyId);
}

async function toggleKey(apiKey: KeyListItem) {
  if (isAuditMode.value) return;
  if (togglingIds.value.has(apiKey.id)) return;

  const nextTogglingIds = new Set(togglingIds.value);
  nextTogglingIds.add(apiKey.id);
  togglingIds.value = nextTogglingIds;
  toggleErrors.value = { ...toggleErrors.value, [apiKey.id]: "" };

  const toggled = await settle(() => api.apiKeys.toggle({ id: apiKey.id }));
  const afterToggle = new Set(togglingIds.value);
  afterToggle.delete(apiKey.id);
  togglingIds.value = afterToggle;
  if (!toggled.ok) {
    toggleErrors.value = { ...toggleErrors.value, [apiKey.id]: errorText(toggled.error, "Failed to toggle API key") };
    return;
  }
  if (!toggled.value.success) {
    toggleErrors.value = { ...toggleErrors.value, [apiKey.id]: toggled.value.error };
    return;
  }
  applyState(apiKey.id, { isActive: toggled.value.data.isActive, expiresAt: toggled.value.data.expiresAt });
}

async function toggleRoaming(apiKey: KeyListItem, enabled: boolean) {
  if (isAuditMode.value) return;
  if (roamingUpdatingIds.value.has(apiKey.id)) return;

  const nextUpdatingIds = new Set(roamingUpdatingIds.value);
  nextUpdatingIds.add(apiKey.id);
  roamingUpdatingIds.value = nextUpdatingIds;
  roamingErrors.value = { ...roamingErrors.value, [apiKey.id]: "" };

  const updated = await settle(() => api.apiKeys.updateRoaming({ id: apiKey.id, enabled }));
  const afterUpdate = new Set(roamingUpdatingIds.value);
  afterUpdate.delete(apiKey.id);
  roamingUpdatingIds.value = afterUpdate;
  if (!updated.ok) {
    roamingErrors.value = { ...roamingErrors.value, [apiKey.id]: errorText(updated.error, "Failed to update roaming") };
    return;
  }
  if (!updated.value.success) {
    roamingErrors.value = { ...roamingErrors.value, [apiKey.id]: updated.value.error };
    return;
  }
  applyPatch(apiKey.id, { roamingEnabled: updated.value.data.roamingEnabled });
}

function updateModels(apiKeyId: string, value: { mode: AccessMode; models: string[] }) {
  if (!data.value) return;
  data.value = {
    ...data.value,
    apiKeys: data.value.apiKeys.map((apiKey) => (apiKey.id === apiKeyId ? { ...apiKey, modelAccessMode: value.mode, modelAccessList: value.models } : apiKey)),
  };
}

function updateAccess(apiKeyId: string, value: { mode: AccessMode; accounts: string[] }) {
  if (!data.value) return;
  data.value = {
    ...data.value,
    apiKeys: data.value.apiKeys.map((apiKey) => (apiKey.id === apiKeyId ? { ...apiKey, accountAccessMode: value.mode, accountAccessList: value.accounts } : apiKey)),
  };
}

function saveLimits(apiKeyId: string, rules: RateLimitRule[]) {
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
    <div class="web-header-divider">
      <div class="flex min-h-9 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 class="inline-flex min-h-9 items-center gap-2 text-xl font-semibold">
          API Keys
          <UiBadge v-if="apiKeys.length > 0" variant="outline" class="text-xs">{{ activeCount }}/{{ apiKeys.length }}</UiBadge>
        </h2>
        <div class="flex w-full items-center sm:w-auto">
          <CreateApiKeyButton :readonly="isAuditMode" trigger-class="flex-1 sm:w-auto sm:flex-none" @created="refresh" />
        </div>
      </div>
    </div>

    <DataNotice :error="error" />

    <UiCard class="bg-card">
      <UiCardContent class="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div class="min-w-0 space-y-1">
          <p class="text-sm font-medium">Proxy Base URL</p>
          <code class="block break-all text-sm text-muted-foreground">{{ proxyBaseUrl }}</code>
        </div>
        <UiButton type="button" variant="outline" class="shrink-0" @click="copyProxy">
          <UiIcon :name="copiedProxy ? 'i-lucide-check' : 'i-lucide-copy'" class="size-4" />
          {{ copiedProxy ? 'Copied' : 'Copy' }}
        </UiButton>
      </UiCardContent>
    </UiCard>

    <section v-if="apiKeys.length > 0" class="scroll-mt-24 space-y-4 md:space-y-2">
      <div class="web-card-grid">
        <UiCard
          v-for="apiKey in apiKeys"
          :key="apiKey.id"
          class="flex h-full flex-col bg-transparent transition-colors"
          :class="keyStatus(apiKey).label !== 'Active' ? 'opacity-65' : ''"
        >
          <UiCardHeader class="pb-1">
            <div class="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
              <div class="min-w-0 overflow-hidden">
                <EditableApiKeyName :id="apiKey.id" :name="apiKey.name" :key-preview="apiKey.keyPreview" :show-edit-button="false" :readonly="isAuditMode" @updated="applyPatch(apiKey.id, $event)" />
              </div>
              <div class="flex h-7 shrink-0 items-center justify-end gap-1.5">
                <span class="text-[11px] leading-none text-muted-foreground">{{ keyActive(apiKey) ? 'On' : 'Off' }}</span>
                <UiSwitch
                  :model-value="keyActive(apiKey)"
                  :disabled="togglingIds.has(apiKey.id) || isAuditMode"
                  :title="keyActive(apiKey) ? 'Disable' : 'Enable'"
                  @update:model-value="toggleKey(apiKey)"
                />
              </div>
            </div>
            <p v-if="toggleErrors[apiKey.id]" class="mt-1 text-xs text-destructive">{{ toggleErrors[apiKey.id] }}</p>
          </UiCardHeader>

          <UiCardContent class="flex flex-1 flex-col pt-0">
            <div class="flex-1 space-y-3 text-sm">
              <ApiKeyActions :api-key="apiKey" :readonly="isAuditMode" @renamed="applyPatch(apiKey.id, $event)" @deleted="removeKey" />

              <div class="space-y-2 pt-2">
                <div class="flex items-center justify-between gap-4">
                  <span class="text-muted-foreground">Expiration</span>
                  <div class="text-right">
                    <ApiKeyExpiration :api-key-id="apiKey.id" :initial-expires-at="apiKey.expiresAt" :readonly="isAuditMode" @updated="applyPatch(apiKey.id, $event)" />
                  </div>
                </div>
                <div class="flex justify-between gap-4">
                  <span class="text-muted-foreground">Last used</span>
                  <span class="text-right font-medium">{{ apiKey.lastUsedAt ? relativeTime(apiKey.lastUsedAt) : '-' }}</span>
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
                          <p class="font-medium text-foreground">Roaming</p>
                          <p class="text-muted-foreground">If all accounts fail, this API key can use shared models. Roaming points scale with the tokens used and the model's cost.</p>
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
                          <p class="font-medium text-foreground">Roaming</p>
                          <p class="text-muted-foreground">If all accounts fail, this API key can use shared models. Roaming points scale with the tokens used and the model's cost.</p>
                        </div>
                      </template>
                    </UiPopover>
                  </span>
                  <div class="flex items-center gap-1.5">
                    <span v-if="apiKey.roamingEnabled" class="flex items-center gap-1 text-[11px] leading-none text-foreground">
                      <UiIcon name="i-lucide-coins" class="size-3" />
                      <span class="inline-flex items-center leading-none tabular-nums">{{ formatPoints(apiKey.roamingPointsUsed) }}</span>
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
                <ApiKeyAccessSection title="Model Access" :badge="accessBadge(apiKey.modelAccessMode)">
                  <ApiKeyModelAccess
                    :api-key-id="apiKey.id"
                    :available-models="options?.modelAccessModels ?? options?.availableModels ?? []"
                    :initial-mode="accessMode(apiKey.modelAccessMode)"
                    :initial-models="apiKey.modelAccessList"
                    :readonly="isAuditMode"
                    @updated="updateModels(apiKey.id, $event)"
                  />
                </ApiKeyAccessSection>

                <ApiKeyAccessSection title="Account Access" :badge="accessBadge(apiKey.accountAccessMode)">
                  <ApiKeyAccountAccess
                    :api-key-id="apiKey.id"
                    :available-accounts="options?.providerAccounts ?? []"
                    :initial-mode="accessMode(apiKey.accountAccessMode)"
                    :initial-accounts="apiKey.accountAccessList"
                    :readonly="isAuditMode"
                    @updated="updateAccess(apiKey.id, $event)"
                  />
                </ApiKeyAccessSection>

                <ApiKeyAccessSection title="Rate Limits" :badge="limitBadge(apiKey.id)">
                  <ApiKeyRateLimit
                    :api-key-id="apiKey.id"
                    :available-models="options?.availableModels ?? []"
                    :available-families="options?.availableFamilies ?? []"
                    :initial-rules="limitsOf(apiKey.id)"
                    :readonly="isAuditMode"
                    @updated="saveLimits(apiKey.id, $event)"
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
