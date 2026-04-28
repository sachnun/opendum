<script setup lang="ts">
import { PROVIDER_ACCOUNT_DEFINITIONS } from "../../../lib/provider-accounts";

definePageMeta({ middleware: "auth", layout: "dashboard" });

const { $client } = useNuxtApp();
const providers = PROVIDER_ACCOUNT_DEFINITIONS;

type ProviderAccountListItem = Awaited<ReturnType<typeof $client.accounts.list.query>>[number];

const { data, error, pending } = await useAsyncData("dashboard-accounts", () => $client.accounts.list.query());
const accounts = computed<ProviderAccountListItem[]>(() => data.value ?? []);

function countFor(provider: string) {
  return accounts.value.filter((account) => account.provider === provider).length;
}
</script>

<template>
  <div class="space-y-6">
    <DashboardPageHeader title="Accounts" description="Connect provider accounts and review their health by provider." />
    <DashboardDataNotice :error="error" />
    <USkeleton v-if="pending" class="h-96 rounded-xl" />
    <div v-else class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      <UCard v-for="provider in providers" :key="provider.key">
        <NuxtLink :to="`/dashboard/accounts/${provider.key}`" class="block space-y-4">
          <div class="flex items-start justify-between gap-3">
            <div>
              <h2 class="font-semibold">{{ provider.label }}</h2>
              <p class="text-sm text-muted-foreground">{{ countFor(provider.key) }} connected accounts</p>
            </div>
            <UBadge :color="countFor(provider.key) > 0 ? 'success' : 'neutral'" variant="soft">
              {{ countFor(provider.key) > 0 ? 'Connected' : 'Empty' }}
            </UBadge>
          </div>
          <div class="flex items-center justify-between rounded-lg border border-border bg-muted/20 p-3 text-sm text-muted-foreground">
            <span>Manage provider</span>
            <UIcon name="i-lucide-arrow-right" class="size-4" />
          </div>
        </NuxtLink>
      </UCard>
    </div>
  </div>
</template>
