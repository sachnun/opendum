<script setup lang="ts">
type Account = Awaited<ReturnType<typeof useNuxtApp>["$client"]["accounts"]["byProviderDetailed"]["query"]>["accounts"][number];

type QuotaProvider = "antigravity" | "copilot" | "codex" | "gemini_cli" | "kiro" | "openrouter";

interface QuotaGroupDisplay {
  name: string;
  displayName: string;
  remainingFraction: number;
  resetTimeIso: string | null;
  resetInHuman: string | null;
}

interface AccountQuotaInfo {
  tier: string;
  status: "success" | "error" | "expired";
  error?: string;
  groups: QuotaGroupDisplay[];
}

const QUOTA_PROVIDERS = new Set<string>(["antigravity", "copilot", "codex", "gemini_cli", "kiro", "openrouter"]);
const QUOTA_LAZY_LOAD_ROOT_MARGIN = "400px 0px";

const props = defineProps<{
  account: Account;
  showTier?: boolean;
  supportedModels?: string[];
  disabledModels?: string[];
}>();

const emit = defineEmits<{
  changed: [];
}>();

const { $client } = useNuxtApp();
const isToggling = ref(false);
const isSubtitleVisible = ref(false);
const editDialogOpen = ref(false);
const deleteDialogOpen = ref(false);
const errorDialogOpen = ref(false);
const editName = ref(props.account.name);
const savingName = ref(false);
const deleting = ref(false);
const resolvingErrors = ref(false);
const cardRoot = ref<HTMLElement | null>(null);
const quotaInfo = ref<AccountQuotaInfo | null>(null);
const quotaError = ref<string | null>(null);
const isQuotaLoading = ref(false);
let quotaLoadTriggered = false;
let quotaObserver: IntersectionObserver | null = null;

watch(
  () => props.account.name,
  (value) => {
    editName.value = value;
  }
);

function formatDuration(duration: number | null): string {
  if (duration === null) return "-";
  if (duration >= 1000) return `${(duration / 1000).toFixed(2)}s`;
  return `${duration}ms`;
}

function formatRelativeTime(value: string | Date | null): string {
  if (!value) return "Never";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "Never";

  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString();
}

function formatHourLabel(time: string): string {
  const date = new Date(time);
  return Number.isNaN(date.getTime()) ? time.slice(11, 16) : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatTierLabel(tier: string): string {
  const normalized = tier.trim().toLowerCase();

  switch (normalized) {
    case "free":
      return "Free";
    case "plus":
      return "Plus";
    case "pro":
      return "Pro";
    case "team":
      return "Team";
    case "go":
      return "Go";
    case "business":
      return "Business";
    case "enterprise":
      return "Enterprise";
    case "edu":
    case "education":
      return "Edu";
    case "paid":
    case "standard-tier":
      return "Paid";
    default:
      return normalized
        .split(/[-_\s]+/)
        .filter(Boolean)
        .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
        .join(" ");
  }
}

function isPaidTierValue(tier: string): boolean {
  return ["paid", "standard-tier", "plus", "pro", "team", "go", "business", "enterprise", "edu", "education"].includes(tier.trim().toLowerCase());
}

function maskSensitiveText(value: string): string {
  return value.replace(/[^\s@._-]/g, "•");
}

function getAccountHeader(account: Account): { title: string; subtitle: string | null } {
  const rawName = account.name.trim();
  const rawEmail = account.email?.trim() ?? "";

  if (!rawEmail) return { title: rawName, subtitle: null };

  const normalizedEmail = rawEmail.toLowerCase();
  let title = rawName;
  const trailingEmailMatch = title.match(/\(([^)]+)\)\s*$/);
  if (trailingEmailMatch?.[1]?.trim().toLowerCase() === normalizedEmail) {
    title = title.replace(/\([^)]+\)\s*$/, "").trim();
  }

  if (!title) title = rawEmail;
  if (title.toLowerCase().includes(normalizedEmail)) return { title, subtitle: null };
  return { title, subtitle: rawEmail };
}

const accountHeader = computed(() => getAccountHeader(props.account));
const accountTitle = computed(() => accountHeader.value.title || "Provider account");
const subtitle = computed(() => {
  return accountHeader.value.subtitle;
});
const subtitleDisplay = computed(() => (subtitle.value ? (isSubtitleVisible.value ? subtitle.value : maskSensitiveText(subtitle.value)) : null));
const dailyValues = computed(() => props.account.stats.dailyRequests.map((point) => point.count));
const durationValues = computed(() => props.account.stats.durationLast24Hours.map((point) => point.avgDuration ?? 0));
const durationLabelPoints = computed(() => [props.account.stats.durationLast24Hours[0], props.account.stats.durationLast24Hours[Math.floor(props.account.stats.durationLast24Hours.length / 2)], props.account.stats.durationLast24Hours[props.account.stats.durationLast24Hours.length - 1]].filter(Boolean) as Array<{ time: string; avgDuration: number | null }>);
const peakRequests = computed(() => Math.max(...dailyValues.value, 0));
const effectiveTier = computed(() => {
  const quotaTier = quotaInfo.value?.tier?.trim();
  if (props.account.provider === "codex" && quotaTier && quotaTier.toLowerCase() !== "unknown") return quotaTier;
  return props.account.tier;
});
const normalizedTier = computed(() => effectiveTier.value?.trim().toLowerCase() || "free");
const showTierBadge = computed(() => props.showTier && normalizedTier.value !== "unknown" && normalizedTier.value !== "guest");
const supportsQuotaMonitor = computed(() => QUOTA_PROVIDERS.has(props.account.provider));
const hasSuccessAfterLastError = computed(() => {
  if (!props.account.lastErrorAt) return false;
  const errorMs = new Date(props.account.lastErrorAt).getTime();
  const recoveredMs = Math.max(new Date(props.account.lastSuccessAt ?? 0).getTime() || 0, new Date(props.account.lastRecoveredByRotationAt ?? 0).getTime() || 0);
  return recoveredMs > errorMs;
});
const errorToneClass = computed(() => (hasSuccessAfterLastError.value ? "text-amber-400" : "text-red-500"));

function quotaPercentRemaining(group: QuotaGroupDisplay): number {
  return Math.max(0, Math.min(100, Math.round(group.remainingFraction * 100)));
}

function quotaResetTitle(group: QuotaGroupDisplay): string | undefined {
  if (!group.resetTimeIso) return undefined;
  const resetDate = new Date(group.resetTimeIso);
  return Number.isNaN(resetDate.getTime()) ? undefined : resetDate.toLocaleString();
}

function quotaBarColor(group: QuotaGroupDisplay): string {
  const percentRemaining = quotaPercentRemaining(group);
  if (percentRemaining <= 10) return "bg-red-500";
  if (percentRemaining <= 25) return "bg-orange-500";
  if (percentRemaining <= 50) return "bg-yellow-500";
  return "bg-green-500";
}

function quotaTextColor(group: QuotaGroupDisplay): string {
  const percentRemaining = quotaPercentRemaining(group);
  if (percentRemaining <= 10) return "text-red-400";
  if (percentRemaining <= 25) return "text-orange-400";
  if (percentRemaining <= 50) return "text-yellow-400";
  return "text-green-400";
}

async function loadQuota(forceRefresh = false) {
  if (!supportsQuotaMonitor.value || isQuotaLoading.value) return;

  isQuotaLoading.value = true;
  quotaError.value = null;

  try {
    const result = await $client.accounts.quota.query({
      provider: props.account.provider as QuotaProvider,
      accountId: props.account.id,
      forceRefresh,
    });

    if (!result.success) throw new Error(result.error);
    quotaInfo.value = result.data;
  } catch (error) {
    quotaError.value = error instanceof Error ? error.message : "Failed to fetch quota data";
  } finally {
    isQuotaLoading.value = false;
  }
}

function refreshQuota() {
  quotaLoadTriggered = true;
  loadQuota(true);
}

onMounted(() => {
  if (!supportsQuotaMonitor.value || quotaLoadTriggered) return;

  const node = cardRoot.value;
  if (!node || typeof IntersectionObserver === "undefined") {
    quotaLoadTriggered = true;
    loadQuota();
    return;
  }

  quotaObserver = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      quotaLoadTriggered = true;
      loadQuota();
      quotaObserver?.disconnect();
      quotaObserver = null;
    },
    { rootMargin: QUOTA_LAZY_LOAD_ROOT_MARGIN, threshold: 0.01 }
  );

  quotaObserver.observe(node);
});

onBeforeUnmount(() => {
  quotaObserver?.disconnect();
  quotaObserver = null;
});

async function toggleActive() {
  isToggling.value = true;
  try {
    const result = await $client.accounts.update.mutate({ id: props.account.id, isActive: !props.account.isActive });
    if (!result.success) throw new Error(result.error);
    emit("changed");
  } finally {
    isToggling.value = false;
  }
}

async function renameAccount() {
  savingName.value = true;
  try {
    const result = await $client.accounts.update.mutate({ id: props.account.id, name: editName.value });
    if (!result.success) throw new Error(result.error);
    editDialogOpen.value = false;
    emit("changed");
  } finally {
    savingName.value = false;
  }
}

async function deleteAccount() {
  deleting.value = true;
  try {
    const result = await $client.accounts.delete.mutate({ id: props.account.id });
    if (!result.success) throw new Error(result.error);
    deleteDialogOpen.value = false;
    emit("changed");
  } finally {
    deleting.value = false;
  }
}

async function resolveErrors() {
  resolvingErrors.value = true;
  try {
    const result = await $client.accounts.resolveErrors.mutate({ accountId: props.account.id });
    if (!result.success) throw new Error(result.error);
    errorDialogOpen.value = false;
    emit("changed");
  } finally {
    resolvingErrors.value = false;
  }
}
</script>

<template>
  <div ref="cardRoot" class="h-full">
    <UiCard class="flex h-full flex-col bg-card" :class="!account.isActive ? 'opacity-65' : ''">
      <UiCardHeader class="pb-2">
        <div class="flex min-w-0 items-center justify-between gap-2">
          <UiCardTitle class="min-w-0 truncate text-lg">{{ accountTitle }}</UiCardTitle>
          <div class="flex flex-wrap justify-end gap-1">
            <UiBadge v-if="showTierBadge" variant="outline" :class="isPaidTierValue(normalizedTier) ? 'border-green-500 text-green-600' : ''">
              {{ formatTierLabel(normalizedTier) }}
            </UiBadge>
            <UiBadge v-if="account.status !== 'active'" :variant="account.status === 'failed' ? 'destructive' : 'outline'" :class="account.status === 'degraded' ? 'border-yellow-500 text-yellow-600' : 'gap-1'">
              <UiIcon :name="account.status === 'failed' ? 'i-lucide-alert-circle' : 'i-lucide-triangle-alert'" class="size-3" />
              {{ account.status === 'failed' ? 'Failed' : `Degraded (${account.consecutiveErrors})` }}
            </UiBadge>
          </div>
        </div>
        <div v-if="subtitleDisplay" :class="['grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-1', isSubtitleVisible ? 'items-start' : 'w-full items-center overflow-hidden']">
          <p :class="['min-w-0 font-mono text-sm text-muted-foreground', isSubtitleVisible ? 'break-all whitespace-normal' : 'truncate whitespace-nowrap']">{{ subtitleDisplay }}</p>
          <UiButton variant="ghost" size="icon-sm" class="h-7 w-7 shrink-0 self-start text-muted-foreground hover:text-foreground" @click="isSubtitleVisible = !isSubtitleVisible">
            <UiIcon :name="isSubtitleVisible ? 'i-lucide-eye-off' : 'i-lucide-eye'" class="size-3.5" />
          </UiButton>
        </div>
      </UiCardHeader>
      <UiCardContent class="flex flex-1 flex-col">
        <div class="flex-1 space-y-2 text-sm">
          <div class="mb-3 rounded-md border border-border/70 bg-muted/20 p-2.5">
            <div class="mb-2 flex items-center justify-between text-[11px] text-muted-foreground">
              <span class="inline-flex items-center gap-1"><UiIcon name="i-lucide-bar-chart-3" class="size-3" />30d</span>
              <span class="tabular-nums">{{ peakRequests.toLocaleString() }} peak</span>
            </div>
            <div class="mb-2 grid grid-cols-3 gap-1.5">
              <div class="rounded border border-border/60 bg-background/70 px-2 py-1.5">
                <p class="truncate text-[10px] text-muted-foreground">Requests</p>
                <p class="truncate text-sm font-semibold tabular-nums text-foreground">{{ account.stats.totalRequests.toLocaleString() }}</p>
              </div>
              <div class="rounded border border-border/60 bg-background/70 px-2 py-1.5">
                <p class="truncate text-[10px] text-muted-foreground">Success</p>
                <p class="truncate text-sm font-semibold tabular-nums text-foreground">{{ account.stats.successRate === null ? '-' : `${account.stats.successRate}%` }}</p>
              </div>
              <div class="rounded border border-border/60 bg-background/70 px-2 py-1.5">
                <p class="truncate text-[10px] text-muted-foreground">Latency</p>
                <p class="truncate text-sm font-semibold tabular-nums text-foreground">{{ formatDuration(account.stats.avgDurationLastDay) }}</p>
              </div>
            </div>
            <div class="mb-2 rounded border border-border/60 bg-background/70 px-2 py-1.5">
              <UsageSparkline :values="durationValues" color="var(--chart-2)" :aria-label="`Average duration trend for ${accountTitle} over last 24 hours`" empty-label="No duration data" class="h-6" :height="24" />
              <div class="mt-0.5 grid grid-cols-3 text-[9px] text-muted-foreground">
                <span v-for="point in durationLabelPoints" :key="point.time" class="truncate text-center">{{ formatHourLabel(point.time) }}</span>
              </div>
            </div>
            <UsageSparkline :values="dailyValues" color="var(--chart-2)" :aria-label="`Requests trend for ${accountTitle}`" />
          </div>

          <div class="flex justify-between"><span class="text-muted-foreground">Last used</span><span class="font-medium">{{ formatRelativeTime(account.lastUsedAt) }}</span></div>
          <div class="flex justify-between"><span class="text-muted-foreground">Total Errors</span><span :class="['font-medium', account.errorCount > 0 ? errorToneClass : 'text-muted-foreground']">{{ account.errorCount }}</span></div>
          <div class="flex justify-between"><span class="text-muted-foreground">Last Error</span><span :class="['font-medium', account.lastErrorAt ? errorToneClass : 'text-muted-foreground']">{{ account.lastErrorAt ? formatRelativeTime(account.lastErrorAt) : '-' }}</span></div>

          <div class="min-h-14 border-t">
            <button v-if="account.lastErrorMessage" type="button" class="w-full min-h-[3.25rem] cursor-pointer rounded-sm pt-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" @click="errorDialogOpen = true">
              <div class="flex items-center justify-between gap-1">
                <span class="text-xs text-muted-foreground">Last Error Message:</span>
                <UiButton type="button" variant="ghost" size="icon-xs" class="h-5 w-5" @click.stop="navigator.clipboard.writeText(account.lastErrorMessage ?? '')">
                  <UiIcon name="i-lucide-copy" class="size-3" />
                </UiButton>
              </div>
              <span :class="['mt-1 line-clamp-2 block break-all text-xs', errorToneClass]">{{ account.lastErrorMessage }}</span>
            </button>
            <div v-else class="w-full min-h-[3.25rem] rounded-sm pt-2 text-left">
              <span class="text-xs text-muted-foreground">Last Error Message:</span>
              <span class="mt-1 line-clamp-2 block break-all text-xs text-muted-foreground">-</span>
            </div>
          </div>

          <div v-if="supportsQuotaMonitor" class="mt-3 space-y-2 border-t pt-3">
            <div class="flex items-center justify-between gap-2">
              <span class="text-xs font-medium text-muted-foreground">Quota</span>
              <UiButton
                type="button"
                variant="ghost"
                size="icon-sm"
                class="h-6 w-6"
                :disabled="isQuotaLoading"
                :aria-label="`Refresh quota for ${accountTitle}`"
                title="Refresh quota"
                @click="refreshQuota"
              >
                <UiIcon name="i-lucide-refresh-cw" :class="['size-3.5', isQuotaLoading ? 'animate-spin' : '']" />
              </UiButton>
            </div>

            <div v-if="isQuotaLoading && !quotaInfo" class="space-y-2">
              <UiSkeleton class="h-1.5 w-full rounded-full" />
              <UiSkeleton class="h-1.5 w-full rounded-full" />
            </div>
            <p v-else-if="quotaError" class="text-xs text-red-500">{{ quotaError }}</p>
            <p v-else-if="!quotaInfo" class="text-xs text-muted-foreground">Quota data is not available yet.</p>
            <div v-else-if="quotaInfo.status === 'success' && quotaInfo.groups.length > 0" class="space-y-2">
              <div v-for="group in quotaInfo.groups" :key="group.name" class="space-y-1">
                <div class="flex items-center justify-between gap-2 text-xs">
                  <span class="min-w-0 truncate text-muted-foreground">{{ group.displayName }}</span>
                  <span class="flex items-center gap-2">
                    <span v-if="group.resetInHuman" class="text-[10px] text-muted-foreground" :title="quotaResetTitle(group)">
                      {{ group.resetInHuman }}
                    </span>
                    <span :class="['font-mono', quotaTextColor(group)]">{{ quotaPercentRemaining(group) }}%</span>
                  </span>
                </div>
                <div class="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div class="h-full transition-all duration-300" :class="quotaBarColor(group)" :style="{ width: `${quotaPercentRemaining(group)}%` }" />
                </div>
              </div>
            </div>
            <p v-else class="text-xs text-red-500">{{ quotaInfo.error ?? 'Failed to fetch quota data.' }}</p>
          </div>

          <AccountModelAccess v-if="supportedModels?.length" :account-id="account.id" :supported-models="supportedModels" :initial-disabled-models="disabledModels ?? []" />
        </div>
        <div class="mt-4 flex items-center justify-between gap-2">
          <div class="flex items-center gap-2">
            <UiButton variant="outline" size="sm" @click="editDialogOpen = true"><UiIcon name="i-lucide-pencil" class="size-3" /></UiButton>
            <UiButton variant="outline" size="sm" @click="deleteDialogOpen = true"><UiIcon name="i-lucide-trash-2" class="size-3 text-destructive" /></UiButton>
            <NuxtLink v-if="account.isActive" :to="`/dashboard/playground?accountId=${account.id}`">
              <UiButton variant="outline" size="sm" title="Open in Playground"><UiIcon name="i-lucide-flask-conical" class="size-3" /></UiButton>
            </NuxtLink>
          </div>
          <div class="flex shrink-0 items-center gap-1.5">
            <span class="text-[11px] text-muted-foreground">{{ account.isActive ? 'On' : 'Off' }}</span>
            <UiSwitch :model-value="account.isActive" :disabled="isToggling" @update:model-value="toggleActive" />
          </div>
        </div>
      </UiCardContent>
    </UiCard>

    <UiDialog v-model:open="editDialogOpen" :ui="{ content: 'sm:max-w-md' }">
      <template #content>
        <div class="space-y-1.5 pr-6"><h2 class="text-lg font-semibold">Rename Account</h2><p class="text-sm text-muted-foreground">Enter a new name for this account.</p></div>
        <label class="grid gap-1 text-sm font-medium">Name<input v-model="editName" class="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50" @keydown.enter.prevent="renameAccount"></label>
        <div class="flex justify-end gap-2"><UiButton variant="outline" @click="editDialogOpen = false">Cancel</UiButton><UiButton :disabled="savingName" @click="renameAccount">{{ savingName ? 'Saving...' : 'Save' }}</UiButton></div>
      </template>
    </UiDialog>

    <UiDialog v-model:open="deleteDialogOpen" :ui="{ content: 'sm:max-w-md' }">
      <template #content>
        <div class="space-y-1.5 pr-6"><h2 class="text-lg font-semibold">Delete Account</h2><p class="text-sm text-muted-foreground">Are you sure you want to delete "{{ account.name }}"? This action cannot be undone.</p></div>
        <div class="flex justify-end gap-2"><UiButton variant="outline" @click="deleteDialogOpen = false">Cancel</UiButton><UiButton variant="destructive" :disabled="deleting" @click="deleteAccount">{{ deleting ? 'Deleting...' : 'Delete' }}</UiButton></div>
      </template>
    </UiDialog>

    <UiDialog v-model:open="errorDialogOpen" :ui="{ content: 'sm:max-w-2xl' }">
      <template #content>
        <div class="space-y-1.5 pr-6"><h2 class="text-lg font-semibold">Last Error Message</h2><p class="text-sm text-muted-foreground">Current stored error details for this provider account.</p></div>
        <pre class="max-h-80 overflow-auto rounded-md border border-border bg-muted/40 p-3 text-xs whitespace-pre-wrap">{{ account.lastErrorMessage }}</pre>
        <div class="flex justify-end gap-2"><UiButton variant="outline" @click="navigator.clipboard.writeText(account.lastErrorMessage ?? '')"><UiIcon name="i-lucide-copy" class="size-4" />Copy</UiButton><UiButton :disabled="resolvingErrors" @click="resolveErrors">{{ resolvingErrors ? 'Resolving...' : 'Resolve errors' }}</UiButton></div>
      </template>
    </UiDialog>
  </div>
</template>
