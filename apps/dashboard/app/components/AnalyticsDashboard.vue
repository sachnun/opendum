<script setup lang="ts">
import { endOfDay, format, startOfDay } from "date-fns";
import type { AnalyticsData, ApiKeyListItem } from "../../lib/dashboard-api-types";

type Period = "5m" | "15m" | "30m" | "1h" | "6h" | "24h" | "7d" | "30d" | "90d";
type AnalyticsFilter = Period | { from: string; to: string };
type DateRange = { from: Date; to: Date };
type StatDeltaTone = "positive" | "negative" | "neutral";
type StatHitEffect = { text: string; tone: StatDeltaTone; version: number };
type StatMetric = { key: string; label: string; value: string; numericValue: number; hint?: string; formatDelta?: (delta: number) => string };

const AUTO_REFRESH_INTERVAL_MS = 5000;

const props = withDefaults(
  defineProps<{
    apiKeyId?: string;
  }>(),
  {
    apiKeyId: "all",
  }
);

const dashboardApi = useDashboardApi();
const router = useRouter();

const periods: { value: Period; label: string }[] = [
  { value: "5m", label: "Last 5 minutes" },
  { value: "15m", label: "Last 15 minutes" },
  { value: "30m", label: "Last 30 minutes" },
  { value: "1h", label: "Last 1 hour" },
  { value: "6h", label: "Last 6 hours" },
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
];
const quickPeriods = periods.filter((item) => ["15m", "1h", "24h", "7d", "30d"].includes(item.value));

const period = ref<Period>("24h");
const selectedApiKeyId = ref(props.apiKeyId || "all");
const customRange = ref<DateRange | null>(null);
const draftFromDate = ref("");
const draftToDate = ref("");
const isCustomRangeActive = ref(false);
const isFilterOpen = ref(false);
const isApiKeyFilterOpen = ref(false);
const statHitEffects = ref<Record<string, StatHitEffect>>({});
const previousStatValues = ref<Record<string, number> | null>(null);

let analyticsRefreshTimer: ReturnType<typeof setInterval> | null = null;
let analyticsRefreshInFlight: Promise<void> | null = null;

watch(
  () => props.apiKeyId,
  (value) => {
    selectedApiKeyId.value = value || "all";
  }
);

watch(isFilterOpen, (open) => {
  if (!open) return;
  draftFromDate.value = customRange.value?.from ? format(customRange.value.from, "yyyy-MM-dd") : "";
  draftToDate.value = customRange.value?.to ? format(customRange.value.to, "yyyy-MM-dd") : "";
});

const { data: apiKeysData } = await useAsyncData("dashboard-analytics-api-keys", () => dashboardApi.apiKeys.list(), {
  default: () => [] as ApiKeyListItem[],
});
const apiKeys = computed<ApiKeyListItem[]>(() => apiKeysData.value ?? []);

const selectedPeriod = computed(() => periods.find((item) => item.value === period.value) ?? periods[5]!);
const customRangeLabel = computed(() => {
  if (!customRange.value) return "Custom range";
  return `${format(customRange.value.from, "dd MMM yyyy")} - ${format(customRange.value.to, "dd MMM yyyy")}`;
});
const activeFilterLabel = computed(() => (isCustomRangeActive.value ? customRangeLabel.value : selectedPeriod.value.label));
const selectedApiKeyLabel = computed(() => {
  if (selectedApiKeyId.value === "all") return "All API keys";

  const apiKey = apiKeys.value.find((item) => item.id === selectedApiKeyId.value);
  return apiKey ? `${apiKey.name ?? "Unnamed key"} (${apiKey.keyPreview})` : selectedApiKeyId.value;
});
const activeFilter = computed<AnalyticsFilter>(() => {
  if (isCustomRangeActive.value && customRange.value) {
    return {
      from: startOfDay(customRange.value.from).toISOString(),
      to: endOfDay(customRange.value.to).toISOString(),
    };
  }

  return period.value;
});
const activeFilterKey = computed(() => {
  if (typeof activeFilter.value === "string") return activeFilter.value;
  return `${activeFilter.value.from}-${activeFilter.value.to}`;
});

const { data, error, pending, refresh } = await useAsyncData<AnalyticsData>(
  () => `dashboard-analytics-${selectedApiKeyId.value}-${activeFilterKey.value}`,
  () => dashboardApi.analytics.data({
    filter: activeFilter.value,
    apiKeyId: selectedApiKeyId.value === "all" ? undefined : selectedApiKeyId.value,
  }),
  { watch: [selectedApiKeyId, activeFilterKey] }
);

const isInitialLoading = computed(() => pending.value && !data.value);

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

function formatSignedInteger(delta: number): string {
  const sign = delta > 0 ? "+" : "-";
  return `${sign} ${compactNumber(Math.abs(Math.round(delta)))}`;
}

function formatSignedDuration(delta: number): string {
  const sign = delta > 0 ? "+" : "-";
  return `${sign} ${formatDuration(Math.abs(delta))}`;
}

function formatSignedPercent(delta: number): string {
  const sign = delta > 0 ? "+" : "-";
  const value = Math.round(Math.abs(delta) * 10) / 10;
  return `${sign} ${value}%`;
}

function collectStatValues(items: StatMetric[]): Record<string, number> {
  const values: Record<string, number> = {};

  for (const item of items) {
    if (Number.isFinite(item.numericValue)) values[item.key] = item.numericValue;
  }

  return values;
}

function parseDraftDate(value: string): Date | null {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function handlePeriodChange(value: Period): void {
  period.value = value;
  isCustomRangeActive.value = false;
  isFilterOpen.value = false;
}

async function handleApiKeyChange(apiKeyId: string): Promise<void> {
  selectedApiKeyId.value = apiKeyId;
  isApiKeyFilterOpen.value = false;
  await router.push(apiKeyId === "all" ? "/dashboard" : `/dashboard/analistik/${apiKeyId}`);
}

function handleApplyCustomRange(): void {
  const fromDate = parseDraftDate(draftFromDate.value);
  const toDate = parseDraftDate(draftToDate.value);

  if (!fromDate || !toDate) return;
  customRange.value = fromDate <= toDate ? { from: fromDate, to: toDate } : { from: toDate, to: fromDate };
  isCustomRangeActive.value = true;
  isFilterOpen.value = false;
}

function handleClearCustomRange(): void {
  draftFromDate.value = "";
  draftToDate.value = "";
  customRange.value = null;
  isCustomRangeActive.value = false;
}

async function refreshAnalyticsOnce(): Promise<void> {
  if (pending.value || analyticsRefreshInFlight) return;

  analyticsRefreshInFlight = refresh().then(() => undefined).catch(() => undefined);
  try {
    await analyticsRefreshInFlight;
  } finally {
    analyticsRefreshInFlight = null;
  }
}

const statMetrics = computed<StatMetric[]>(() => {
  const analytics = data.value;

  if (!analytics) return [];

  const { totals, requestsByModel } = analytics;
  const totalTokens = totals.totalInputTokens + totals.totalOutputTokens;
  const failedRequests = totals.totalRequests - Math.round((totals.successRate / 100) * totals.totalRequests);
  const avgTokensPerReq = totals.totalRequests > 0 ? Math.round(totalTokens / totals.totalRequests) : 0;
  const avgInPerReq = totals.totalRequests > 0 ? Math.round(totals.totalInputTokens / totals.totalRequests) : 0;
  const avgOutPerReq = totals.totalRequests > 0 ? Math.round(totals.totalOutputTokens / totals.totalRequests) : 0;
  const topModel = requestsByModel[0];
  const topModelPct = topModel && totals.totalRequests > 0 ? Math.round((topModel.count / totals.totalRequests) * 100) : 0;

  return [
    { key: "totalRequests", label: "Total Requests", value: compactNumber(totals.totalRequests), numericValue: totals.totalRequests, hint: `${failedRequests.toLocaleString()} failed`, formatDelta: formatSignedInteger },
    { key: "totalTokens", label: "Total Tokens", value: compactNumber(totalTokens), numericValue: totalTokens, hint: `${compactNumber(totals.totalInputTokens)} in / ${compactNumber(totals.totalOutputTokens)} out`, formatDelta: formatSignedInteger },
    { key: "modelsUsed", label: "Models Used", value: requestsByModel.length.toString(), numericValue: requestsByModel.length, hint: topModel ? `Top: ${topModel.model.split("/").pop()} (${topModelPct}%)` : undefined, formatDelta: formatSignedInteger },
    { key: "p50Latency", label: "P50 Latency", value: formatDuration(totals.durationPercentiles.p50), numericValue: totals.durationPercentiles.p50, hint: `p95 ${formatDuration(totals.durationPercentiles.p95)} · p99 ${formatDuration(totals.durationPercentiles.p99)}`, formatDelta: formatSignedDuration },
    { key: "successRate", label: "Success Rate", value: totals.totalRequests > 0 ? `${totals.successRate}%` : "-", numericValue: totals.totalRequests > 0 ? totals.successRate : Number.NaN, hint: totals.totalRequests > 0 ? `${Math.round((totals.successRate / 100) * totals.totalRequests).toLocaleString()} / ${totals.totalRequests.toLocaleString()}` : undefined, formatDelta: formatSignedPercent },
    { key: "avgTokensPerReq", label: "Avg Tokens/Req", value: totals.totalRequests > 0 ? compactNumber(avgTokensPerReq) : "-", numericValue: totals.totalRequests > 0 ? avgTokensPerReq : Number.NaN, hint: totals.totalRequests > 0 ? `${compactNumber(avgInPerReq)} in / ${compactNumber(avgOutPerReq)} out` : undefined, formatDelta: formatSignedInteger },
  ];
});

const stats = computed(() => statMetrics.value.map((stat) => ({ ...stat, hit: statHitEffects.value[stat.key] })));

watch(statMetrics, (items) => {
  const nextValues = collectStatValues(items);
  const previousValues = previousStatValues.value;

  if (!previousValues) {
    previousStatValues.value = nextValues;
    return;
  }

  const nextHitEffects = { ...statHitEffects.value };

  for (const item of items) {
    const currentValue = nextValues[item.key];
    const previousValue = previousValues[item.key];

    if (currentValue === undefined || previousValue === undefined) continue;

    const delta = currentValue - previousValue;
    if (!Number.isFinite(delta) || Math.abs(delta) < 0.0001) continue;

    nextHitEffects[item.key] = {
      text: item.formatDelta ? item.formatDelta(delta) : formatSignedInteger(delta),
      tone: delta > 0 ? "positive" : "negative",
      version: (nextHitEffects[item.key]?.version ?? 0) + 1,
    };
  }

  previousStatValues.value = nextValues;
  statHitEffects.value = nextHitEffects;
}, { immediate: true });

watch([selectedApiKeyId, activeFilterKey], () => {
  previousStatValues.value = null;
  statHitEffects.value = {};
});

onMounted(() => {
  analyticsRefreshTimer = setInterval(() => {
    void refreshAnalyticsOnce();
  }, AUTO_REFRESH_INTERVAL_MS);
});

onBeforeUnmount(() => {
  if (analyticsRefreshTimer) clearInterval(analyticsRefreshTimer);
});

const requestsSeries = [{ key: "count", label: "Requests", color: "var(--chart-1)", area: true }];
const tokenSeries = [
  { key: "input", label: "Input Tokens", color: "var(--chart-1)", area: true },
  { key: "output", label: "Output Tokens", color: "var(--chart-2)", area: true },
];
const successSeries = [
  { key: "successRate", label: "Success", color: "var(--chart-2)", suffix: "%" },
  { key: "errorRate", label: "Error", color: "var(--destructive)", suffix: "%", dashed: true },
];
const successRateData = computed(() =>
  (data.value?.successRate ?? []).map((point) => {
    const total = point.success + point.error;
    return {
      ...point,
      successRate: point.successRate ?? (total > 0 ? Math.round((point.success / total) * 1000) / 10 : 0),
      errorRate: point.errorRate ?? (total > 0 ? Math.round((point.error / total) * 1000) / 10 : 0),
    };
  })
);
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-start">
      <div class="flex min-w-0 items-center gap-2">
        <UiPopover v-model:open="isApiKeyFilterOpen" :content="{ align: 'start' }">
          <UiButton
            variant="outline"
            size="sm"
            :disabled="pending || apiKeys.length === 0"
            class="h-8 min-w-0 justify-between overflow-hidden rounded-lg border-border bg-background px-2.5 text-xs sm:h-9 sm:min-w-48 sm:text-sm"
          >
            <span class="inline-flex min-w-0 items-center gap-1.5">
              <UiIcon name="i-lucide-key-round" class="size-3.5 shrink-0 text-muted-foreground" />
              <span class="truncate">{{ selectedApiKeyLabel }}</span>
            </span>
            <UiIcon name="i-lucide-chevron-down" class="size-3.5 shrink-0 text-muted-foreground" />
          </UiButton>

          <template #content>
            <div class="w-80 max-w-[calc(100vw-2rem)] space-y-1 p-2">
              <UiButton
                variant="ghost"
                size="sm"
                :class="['h-8 w-full justify-start rounded-md px-2.5 text-xs', selectedApiKeyId === 'all' ? 'bg-secondary text-secondary-foreground hover:bg-secondary/80' : '']"
                :disabled="pending"
                @click="handleApiKeyChange('all')"
              >
                All API keys
              </UiButton>
              <UiButton
                v-for="apiKey in apiKeys"
                :key="apiKey.id"
                variant="ghost"
                size="sm"
                :class="['h-8 w-full justify-start rounded-md px-2.5 text-xs', selectedApiKeyId === apiKey.id ? 'bg-secondary text-secondary-foreground hover:bg-secondary/80' : '']"
                :disabled="pending"
                @click="handleApiKeyChange(apiKey.id)"
              >
                <span class="truncate">{{ apiKey.name ?? 'Unnamed key' }}</span>
                <span class="ml-1 truncate text-[11px] text-muted-foreground">{{ apiKey.keyPreview }}</span>
              </UiButton>
            </div>
          </template>
        </UiPopover>

        <UiPopover v-model:open="isFilterOpen" :content="{ align: 'end', class: 'w-auto p-0' }">
          <UiButton
            variant="outline"
            size="sm"
            :disabled="pending"
            class="h-8 min-w-0 justify-between overflow-hidden rounded-lg border-border bg-background px-2.5 text-xs sm:h-9 sm:min-w-48 sm:text-sm"
          >
            <span class="inline-flex min-w-0 items-center gap-1.5">
              <UiIcon name="i-lucide-clock-3" class="size-3.5 shrink-0 text-muted-foreground" />
              <span class="hidden truncate sm:inline">{{ activeFilterLabel }}</span>
              <span class="sm:hidden">{{ isCustomRangeActive ? 'custom' : selectedPeriod.value }}</span>
            </span>
            <UiIcon name="i-lucide-chevron-down" class="size-3.5 shrink-0 text-muted-foreground" />
          </UiButton>

          <template #content>
            <div class="space-y-2 p-3">
              <p class="text-xs font-medium text-muted-foreground">Quick ranges</p>
              <div class="grid grid-cols-1 gap-1">
                <UiButton
                  v-for="item in quickPeriods"
                  :key="item.value"
                  variant="ghost"
                  size="sm"
                  :class="['h-8 justify-start rounded-md px-2.5 text-xs', !isCustomRangeActive && period === item.value ? 'bg-secondary text-secondary-foreground hover:bg-secondary/80' : '']"
                  :disabled="pending"
                  @click="handlePeriodChange(item.value)"
                >
                  {{ item.label }}
                </UiButton>
              </div>
            </div>
            <div class="h-px bg-border" />
            <div class="space-y-3 p-3">
              <p class="text-xs font-medium text-muted-foreground">Custom range</p>
              <div class="grid gap-2 sm:grid-cols-2">
                <label class="grid gap-1 text-xs text-muted-foreground">
                  From
                  <input v-model="draftFromDate" type="date" class="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50">
                </label>
                <label class="grid gap-1 text-xs text-muted-foreground">
                  To
                  <input v-model="draftToDate" type="date" class="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50">
                </label>
              </div>
              <div class="flex items-center justify-between gap-2">
                <UiButton
                  variant="ghost"
                  size="sm"
                  class="h-8 px-2.5 text-xs"
                  :disabled="pending || (!isCustomRangeActive && !draftFromDate && !draftToDate)"
                  @click="handleClearCustomRange"
                >
                  Clear
                </UiButton>
                <UiButton
                  size="sm"
                  class="h-8 px-2.5 text-xs"
                  :disabled="pending || !draftFromDate || !draftToDate"
                  @click="handleApplyCustomRange"
                >
                  Apply range
                </UiButton>
              </div>
            </div>
          </template>
        </UiPopover>

        <span class="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-xs text-muted-foreground sm:h-9">
          <span class="size-1.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.75)]" />
          Auto 5s
        </span>
      </div>
    </div>

    <DashboardDataNotice :error="error" />

    <div v-if="isInitialLoading" class="grid gap-3 grid-cols-[repeat(auto-fill,minmax(160px,1fr))]">
      <div v-for="item in 6" :key="item" class="rounded-xl border border-border bg-muted/40 px-4 py-4 sm:px-5">
        <UiSkeleton class="h-3.5 w-20" />
        <UiSkeleton class="mt-2 h-8 w-20 sm:h-9" />
        <UiSkeleton class="mt-1 h-3 w-28" />
      </div>
    </div>
    <div v-else-if="data" class="grid gap-3 grid-cols-[repeat(auto-fill,minmax(160px,1fr))]">
      <DashboardStatCard
        v-for="stat in stats"
        :key="stat.label"
        :label="stat.label"
        :value="stat.value"
        :hint="stat.hint"
        :delta="stat.hit?.text"
        :delta-key="stat.hit?.version"
        :delta-tone="stat.hit?.tone"
      />
    </div>

    <div v-if="!isInitialLoading && data" class="grid gap-3 grid-cols-1 md:grid-cols-[repeat(auto-fill,minmax(480px,1fr))]">
      <AnalyticsTimeSeriesChart
        title="Requests Over Time"
        :data="data.requestsOverTime"
        :granularity="data.granularity"
        :series="requestsSeries"
      />
      <AnalyticsTimeSeriesChart
        title="Token Usage"
        :data="data.tokenUsage"
        :granularity="data.granularity"
        :series="tokenSeries"
      />
      <AnalyticsRequestsByModelChart :data="data.requestsByModel" />
      <AnalyticsTimeSeriesChart
        title="Success / Error Rate"
        :data="successRateData"
        :granularity="data.granularity"
        :series="successSeries"
        :max-value="100"
      />
    </div>
    <UiCard v-else-if="!isInitialLoading" class="border-border/50 bg-card/50 py-8">
      <UiCardContent class="px-5 text-sm text-muted-foreground sm:text-base">
        No data in the selected time range.
      </UiCardContent>
    </UiCard>
  </div>
</template>
