<script setup lang="ts">
definePageMeta({ middleware: "auth", layout: "dashboard" });

const route = useRoute();
const { $client } = useNuxtApp();
const apiKeyId = computed(() => String(route.params.apiKeyId));

interface ApiKeyAnalyticsSummary {
  requests: number;
  tokens: number;
  errors: number;
}

const { data, error, pending } = await useAsyncData(
  `dashboard-key-analytics-${apiKeyId.value}`,
  () => $client.analytics.byApiKey.query({ apiKeyId: apiKeyId.value }),
  { watch: [apiKeyId] }
);
const summary = computed<ApiKeyAnalyticsSummary | null>(() => data.value as ApiKeyAnalyticsSummary | null);
const totalRequests = computed(() => summary.value?.requests ?? 0);
const totalTokens = computed(() => summary.value?.tokens ?? 0);
const errorCount = computed(() => summary.value?.errors ?? 0);
</script>

<template>
  <div class="space-y-6">
    <DashboardPageHeader title="API key analytics" :description="`Usage details for ${apiKeyId}.`">
      <template #actions>
        <UButton to="/dashboard/api-keys" color="neutral" variant="soft" icon="i-lucide-arrow-left">
          API keys
        </UButton>
      </template>
    </DashboardPageHeader>

    <DashboardDataNotice :error="error" />
    <div v-if="pending" class="grid gap-4 md:grid-cols-3">
      <USkeleton v-for="item in 3" :key="item" class="h-32 rounded-xl" />
    </div>
    <div v-else class="grid gap-4 md:grid-cols-3">
      <DashboardStatCard label="Requests" :value="totalRequests.toLocaleString()" icon="i-lucide-send" />
      <DashboardStatCard label="Tokens" :value="totalTokens.toLocaleString()" icon="i-lucide-binary" />
      <DashboardStatCard label="Errors" :value="errorCount.toLocaleString()" icon="i-lucide-triangle-alert" />
    </div>

    <UCard>
      <div class="space-y-2">
        <h2 class="font-semibold">Breakdown</h2>
        <p class="text-sm text-muted-foreground">
          This page is intentionally compact until the Nuxt analytics procedures expose chart-ready series.
        </p>
      </div>
    </UCard>
  </div>
</template>
