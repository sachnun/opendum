<script setup lang="ts">
definePageMeta({ middleware: "auth", layout: "dashboard" });

const { $client } = useNuxtApp();
const period = ref("24h");
const periods = [
  { value: "15m", label: "Last 15 minutes" },
  { value: "1h", label: "Last 1 hour" },
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
];
const isFilterOpen = ref(false);
const isApiKeyFilterOpen = ref(false);

interface DashboardOverview {
  requests: number;
  tokens: number;
  errors: number;
  successRate?: number;
  avgDuration?: number;
}

type ApiKeyListItem = Awaited<ReturnType<typeof $client.apiKeys.list.query>>[number];

const { data, error, pending, refresh } = await useAsyncData("dashboard-overview", () => $client.analytics.overview.query(), {
  watch: [period],
});
const { data: apiKeysData } = await useAsyncData("dashboard-analytics-api-keys", () => $client.apiKeys.list.query(), {
  default: () => [] as ApiKeyListItem[],
});
const apiKeys = computed<ApiKeyListItem[]>(() => apiKeysData.value ?? []);
const selectedApiKeyId = ref("all");

const selectedPeriod = computed(() => periods.find((item) => item.value === period.value) ?? periods[2]);
const selectedApiKeyLabel = computed(() => {
  const apiKey = apiKeys.value.find((item) => item.id === selectedApiKeyId.value);

  if (!apiKey) {
    return "All API keys";
  }

  return `${apiKey.name ?? "Unnamed key"} (${apiKey.keyPreview})`;
});

function compactNumber(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function formatDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

const stats = computed(() => {
  const source = data.value as DashboardOverview | null;
  const totalRequests = source?.requests ?? 0;
  const totalTokens = source?.tokens ?? 0;
  const failedRequests = source?.errors ?? 0;
  const successRate = source?.successRate ?? 0;
  const avgTokensPerReq = totalRequests > 0 ? Math.round(totalTokens / totalRequests) : 0;

  return [
    { label: "Total Requests", value: compactNumber(totalRequests), hint: `${failedRequests.toLocaleString()} failed` },
    { label: "Total Tokens", value: compactNumber(totalTokens), hint: `${compactNumber(totalTokens)} total` },
    { label: "Models Used", value: "0", hint: "Top: -" },
    { label: "P50 Latency", value: source?.avgDuration ? formatDuration(source.avgDuration) : "-", hint: "p95 - · p99 -" },
    { label: "Success Rate", value: totalRequests > 0 ? `${successRate}%` : "-", hint: totalRequests > 0 ? `${(totalRequests - failedRequests).toLocaleString()} / ${totalRequests.toLocaleString()}` : undefined },
    { label: "Avg Tokens/Req", value: totalRequests > 0 ? compactNumber(avgTokensPerReq) : "-", hint: totalRequests > 0 ? `${compactNumber(avgTokensPerReq)} avg` : undefined },
  ];
});
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
      <h3 class="text-sm font-semibold tracking-tight sm:text-base">Analytics</h3>
      <div class="flex min-w-0 items-center gap-2">
        <UPopover v-model:open="isApiKeyFilterOpen" :content="{ align: 'end' }">
          <button
            type="button"
            :disabled="pending || apiKeys.length === 0"
            class="inline-flex h-8 min-w-0 cursor-pointer items-center justify-between gap-2 overflow-hidden rounded-lg border border-border bg-background px-2.5 text-xs font-medium outline-none transition-all hover:bg-input/50 hover:text-accent-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 sm:h-9 sm:min-w-48 sm:text-sm"
          >
            <span class="inline-flex min-w-0 items-center gap-1.5">
              <UIcon name="i-lucide-key-round" class="size-3.5 shrink-0 text-muted-foreground" />
              <span class="truncate">{{ selectedApiKeyLabel }}</span>
            </span>
            <UIcon name="i-lucide-chevron-down" class="size-3.5 shrink-0 text-muted-foreground" />
          </button>

          <template #content>
            <div class="w-80 max-w-[calc(100vw-2rem)] space-y-1 p-2">
              <button
                type="button"
                :class="[
                  'inline-flex h-8 w-full cursor-pointer items-center justify-start rounded-md px-2.5 text-xs font-medium transition-all',
                  selectedApiKeyId === 'all' ? 'bg-secondary text-secondary-foreground' : 'hover:bg-accent/50 hover:text-accent-foreground',
                ]"
                @click="selectedApiKeyId = 'all'; isApiKeyFilterOpen = false"
              >
                All API keys
              </button>
              <button
                v-for="apiKey in apiKeys"
                :key="apiKey.id"
                type="button"
                :class="[
                  'inline-flex h-8 w-full cursor-pointer items-center justify-start rounded-md px-2.5 text-xs font-medium transition-all',
                  selectedApiKeyId === apiKey.id ? 'bg-secondary text-secondary-foreground' : 'hover:bg-accent/50 hover:text-accent-foreground',
                ]"
                @click="selectedApiKeyId = apiKey.id; isApiKeyFilterOpen = false"
              >
                <span class="truncate">{{ apiKey.name ?? 'Unnamed key' }}</span>
                <span class="ml-1 truncate text-[11px] text-muted-foreground">{{ apiKey.keyPreview }}</span>
              </button>
            </div>
          </template>
        </UPopover>

        <UPopover v-model:open="isFilterOpen" :content="{ align: 'end' }">
          <button
            type="button"
            :disabled="pending"
            class="inline-flex h-8 min-w-0 cursor-pointer items-center justify-between gap-2 overflow-hidden rounded-lg border border-border bg-background px-2.5 text-xs font-medium outline-none transition-all hover:bg-input/50 hover:text-accent-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 sm:h-9 sm:min-w-48 sm:text-sm"
          >
            <span class="inline-flex min-w-0 items-center gap-1.5">
              <UIcon name="i-lucide-clock-3" class="size-3.5 shrink-0 text-muted-foreground" />
              <span class="hidden truncate sm:inline">{{ selectedPeriod.label }}</span>
              <span class="sm:hidden">{{ selectedPeriod.value }}</span>
            </span>
            <UIcon name="i-lucide-chevron-down" class="size-3.5 shrink-0 text-muted-foreground" />
          </button>

          <template #content>
            <div class="space-y-2 p-3">
              <p class="text-xs font-medium text-muted-foreground">Quick ranges</p>
              <div class="grid grid-cols-1 gap-1">
                <button
                  v-for="item in periods"
                  :key="item.value"
                  type="button"
                  :class="[
                    'inline-flex h-8 cursor-pointer items-center justify-start rounded-md px-2.5 text-xs font-medium transition-all',
                    period === item.value ? 'bg-secondary text-secondary-foreground' : 'hover:bg-accent/50 hover:text-accent-foreground',
                  ]"
                  @click="period = item.value; isFilterOpen = false"
                >
                  {{ item.label }}
                </button>
              </div>
            </div>
          </template>
        </UPopover>

        <button
          type="button"
          :disabled="pending"
          class="inline-flex size-8 cursor-pointer items-center justify-center rounded-lg border border-border bg-background text-sm font-medium outline-none transition-all hover:bg-input/50 hover:text-accent-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 sm:size-9"
          @click="refresh()"
        >
          <UIcon name="i-lucide-refresh-cw" :class="['size-4', pending ? 'animate-spin' : '']" />
        </button>
      </div>
    </div>

    <DashboardDataNotice :error="error" />

    <div v-if="pending" class="grid gap-3 grid-cols-[repeat(auto-fill,minmax(160px,1fr))]">
      <div v-for="item in 6" :key="item" class="rounded-xl bg-muted/40 px-4 py-4 sm:px-5">
        <UiSkeleton class="h-3.5 w-20" />
        <UiSkeleton class="mt-2 h-8 w-20 sm:h-9" />
        <UiSkeleton class="mt-1 h-3 w-28" />
      </div>
    </div>
    <div v-else class="grid gap-3 grid-cols-[repeat(auto-fill,minmax(160px,1fr))]">
      <DashboardStatCard
        v-for="stat in stats"
        :key="stat.label"
        :label="stat.label"
        :value="stat.value"
        :hint="stat.hint"
      />
    </div>

    <div class="grid gap-3 grid-cols-1 md:grid-cols-[repeat(auto-fill,minmax(480px,1fr))]">
      <div v-for="title in ['Requests Over Time', 'Token Usage', 'Requests By Model', 'Success Rate']" :key="title" class="rounded-xl border border-border/50 bg-card/50 py-4">
        <div class="px-4 pb-3 sm:px-5">
          <h4 class="text-sm font-medium text-muted-foreground">{{ title }}</h4>
        </div>
        <div class="px-4 pt-0 sm:px-5">
          <div class="flex h-[200px] items-center justify-center rounded-lg border border-dashed border-border/50 text-sm text-muted-foreground">
            No data yet
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
