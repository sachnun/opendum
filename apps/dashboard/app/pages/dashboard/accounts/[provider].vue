<script setup lang="ts">
import { BY_KEY, getProviderFromSlug } from "../../../../lib/provider-accounts";

definePageMeta({ middleware: "auth", layout: "dashboard" });

const route = useRoute();
const { $client } = useNuxtApp();
const selectedProvider = computed(() => getProviderFromSlug(String(route.params.provider)) ?? String(route.params.provider));
const providerMeta = computed(() => selectedProvider.value in BY_KEY ? BY_KEY[selectedProvider.value as keyof typeof BY_KEY] : null);
const accountName = ref("");
const accountToken = ref("");
const saving = ref(false);

type ProviderAccountListItem = Awaited<ReturnType<typeof $client.accounts.byProvider.query>>[number];

const { data, error, pending, refresh } = await useAsyncData(
  () => `dashboard-accounts-${selectedProvider.value}`,
  () => $client.accounts.byProvider.query({ provider: selectedProvider.value }),
  { watch: [selectedProvider] }
);
const accounts = computed<ProviderAccountListItem[]>(() => data.value ?? []);

async function addAccount() {
  saving.value = true;
  try {
    await $client.accounts.create.mutate({ provider: selectedProvider.value, name: accountName.value, token: accountToken.value });
    accountName.value = "";
    accountToken.value = "";
    await refresh();
  } finally {
    saving.value = false;
  }
}

function dailyValues() {
  return Array.from({ length: 30 }, () => 0);
}
</script>

<template>
  <div class="space-y-6">
    <div class="sticky top-0 z-20 -mx-5 bg-background px-5 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
      <div class="border-b border-border pb-4 pt-3">
        <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 class="inline-flex items-center gap-2 text-xl font-semibold">
              <button type="button" class="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
                <UIcon name="i-lucide-pin" class="size-3.5" />
              </button>
              {{ providerMeta?.label ?? selectedProvider.replaceAll('_', ' ') }}
            </h2>
          </div>
          <div class="flex w-full items-center gap-2 sm:w-auto">
            <UiButton class="flex-1 sm:w-auto sm:flex-none" :disabled="saving" @click="addAccount">
              <UIcon name="i-lucide-plus" :class="['size-4', saving ? 'animate-spin' : '']" />
              Add account
            </UiButton>
          </div>
        </div>
      </div>
    </div>

    <DashboardDataNotice :error="error" />

    <UiCard>
      <UiCardContent>
        <div class="grid gap-3 md:grid-cols-[1fr_1fr_auto]">
          <input v-model="accountName" placeholder="Account name" class="h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50">
          <input v-model="accountToken" type="password" placeholder="Token or API key" class="h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50">
          <UiButton :disabled="saving" @click="addAccount">
            <UIcon name="i-lucide-plus" :class="['size-4', saving ? 'animate-spin' : '']" />
            Add account
          </UiButton>
        </div>
      </UiCardContent>
    </UiCard>

    <UiSkeleton v-if="pending" class="h-72 rounded-xl" />
    <DashboardEmptyState v-else-if="accounts.length === 0" title="No accounts connected" :description="providerMeta?.emptyMessage ?? 'No accounts connected yet.'" icon="i-lucide-user-plus" />
    <div v-else class="grid gap-3 grid-cols-[repeat(auto-fill,minmax(320px,1fr))]">
      <UiCard v-for="account in accounts" :key="account.id" class="bg-card py-4" :class="account.isActive === false ? 'opacity-70' : ''">
        <UiCardHeader class="px-4 pb-2 sm:px-5">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <UiCardTitle class="truncate text-base">{{ account.name ?? account.email ?? 'Provider account' }}</UiCardTitle>
              <p class="mt-1 truncate text-xs text-muted-foreground">{{ account.email ?? account.id }}</p>
            </div>
            <UiBadge :variant="account.isActive === false ? 'secondary' : 'outline'" :class="account.isActive === false ? '' : 'border-green-500 text-green-600'">
              {{ account.isActive === false ? 'Disabled' : 'Active' }}
            </UiBadge>
          </div>
        </UiCardHeader>
        <UiCardContent class="space-y-3 px-4 sm:px-5">
          <div class="grid grid-cols-3 gap-1.5 rounded-md border border-border/70 bg-muted/20 p-2.5">
            <div class="rounded border border-border/60 bg-background/70 px-2 py-1.5">
              <p class="truncate text-[10px] text-muted-foreground">Requests</p>
              <p class="truncate text-sm font-semibold tabular-nums text-foreground">{{ account.requestCount ?? 0 }}</p>
            </div>
            <div class="rounded border border-border/60 bg-background/70 px-2 py-1.5">
              <p class="truncate text-[10px] text-muted-foreground">Status</p>
              <p class="truncate text-sm font-semibold text-foreground">{{ account.status ?? '-' }}</p>
            </div>
            <div class="rounded border border-border/60 bg-background/70 px-2 py-1.5">
              <p class="truncate text-[10px] text-muted-foreground">Last used</p>
              <p class="truncate text-sm font-semibold text-foreground">{{ account.lastUsedAt ? new Date(account.lastUsedAt).toLocaleDateString() : '-' }}</p>
            </div>
          </div>
          <UsageSparkline :values="dailyValues()" color="var(--chart-1)" :aria-label="`Requests trend for ${account.name ?? account.id}`" />
        </UiCardContent>
      </UiCard>
    </div>
  </div>
</template>
