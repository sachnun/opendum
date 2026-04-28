<script setup lang="ts">
definePageMeta({ middleware: "auth", layout: "dashboard" });

const { $client } = useNuxtApp();
const range = ref("24h");
const ranges = ["24h", "7d", "30d"];

type UsageRow = Awaited<ReturnType<typeof $client.analytics.usage.query>>[number];

const { data, error, pending, refresh } = await useAsyncData(
  "dashboard-usage",
  () => $client.analytics.usage.query({ range: range.value as "24h" | "7d" | "30d" }),
  { watch: [range] }
);
const rows = computed<UsageRow[]>(() => data.value ?? []);
</script>

<template>
  <div class="space-y-6">
    <DashboardPageHeader title="Usage" description="Inspect recent proxy requests and high-level usage windows.">
      <template #actions>
        <USelect v-model="range" :items="ranges" class="w-28" />
        <UButton color="neutral" variant="soft" icon="i-lucide-refresh-cw" @click="refresh()">
          Refresh
        </UButton>
      </template>
    </DashboardPageHeader>

    <DashboardDataNotice :error="error" />
    <USkeleton v-if="pending" class="h-80 rounded-xl" />
    <DashboardEmptyState v-else-if="rows.length === 0" title="No usage yet" description="Requests routed through the proxy will appear here." icon="i-lucide-book-open" />
    <UCard v-else>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="text-left text-muted-foreground">
            <tr class="border-b border-border">
              <th class="py-3 pr-4 font-medium">Time</th>
              <th class="py-3 pr-4 font-medium">Model</th>
              <th class="py-3 pr-4 font-medium">Provider</th>
              <th class="py-3 pr-4 font-medium">Status</th>
              <th class="py-3 pr-4 text-right font-medium">Tokens</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.id ?? row.createdAt" class="border-b border-border/60 last:border-0">
              <td class="py-3 pr-4 text-muted-foreground">{{ row.createdAt ? new Date(row.createdAt).toLocaleString() : '-' }}</td>
              <td class="py-3 pr-4">{{ row.model ?? '-' }}</td>
              <td class="py-3 pr-4">{{ row.provider ?? '-' }}</td>
              <td class="py-3 pr-4">{{ row.statusCode ?? '-' }}</td>
              <td class="py-3 pr-4 text-right tabular-nums">{{ row.totalTokens.toLocaleString() }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </UCard>
  </div>
</template>
