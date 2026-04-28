<script setup lang="ts">
definePageMeta({ middleware: "auth", layout: "dashboard" });

const route = useRoute();
const { $client } = useNuxtApp();
const provider = computed(() => String(route.params.provider));
const accountName = ref("");
const accountToken = ref("");
const saving = ref(false);

type ProviderAccountListItem = Awaited<ReturnType<typeof $client.accounts.byProvider.query>>[number];

const { data, error, pending, refresh } = await useAsyncData(
  `dashboard-accounts-${provider.value}`,
  () => $client.accounts.byProvider.query({ provider: provider.value }),
  { watch: [provider] }
);
const accounts = computed<ProviderAccountListItem[]>(() => data.value ?? []);

async function addAccount() {
  saving.value = true;
  try {
    await $client.accounts.create.mutate({ provider: provider.value, name: accountName.value, token: accountToken.value });
    accountName.value = "";
    accountToken.value = "";
    await refresh();
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="space-y-6">
    <DashboardPageHeader :title="provider.replaceAll('_', ' ')" description="Manage accounts for this provider.">
      <template #actions>
        <UButton to="/dashboard/accounts" color="neutral" variant="soft" icon="i-lucide-arrow-left">
          Accounts
        </UButton>
      </template>
    </DashboardPageHeader>

    <DashboardDataNotice :error="error" />

    <UCard>
      <div class="grid gap-3 md:grid-cols-[1fr_1fr_auto]">
        <UInput v-model="accountName" placeholder="Account name" />
        <UInput v-model="accountToken" type="password" placeholder="Token or API key" />
        <UButton :loading="saving" icon="i-lucide-plus" @click="addAccount">
          Add account
        </UButton>
      </div>
    </UCard>

    <USkeleton v-if="pending" class="h-72 rounded-xl" />
    <DashboardEmptyState v-else-if="accounts.length === 0" title="No accounts connected" description="Add an account when the provider creation procedure is available." icon="i-lucide-user-plus" />
    <div v-else class="grid gap-4 lg:grid-cols-2">
      <UCard v-for="account in accounts" :key="account.id">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <h2 class="truncate font-semibold">{{ account.name ?? account.email ?? 'Provider account' }}</h2>
            <p class="mt-1 truncate text-sm text-muted-foreground">{{ account.email ?? account.id }}</p>
          </div>
          <UBadge :color="account.isActive === false ? 'neutral' : 'success'" variant="soft">
            {{ account.isActive === false ? 'Disabled' : 'Active' }}
          </UBadge>
        </div>
      </UCard>
    </div>
  </div>
</template>
