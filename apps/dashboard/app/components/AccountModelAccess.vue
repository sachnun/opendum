<script setup lang="ts">
import { compareModelIds } from "../../lib/model-sort";
import type { ProviderAccountModelHealthItem } from "../../lib/dashboard-api-types";

const props = defineProps<{
  accountId: string;
  provider: string;
  supportedModels: string[];
  initialDisabledModels: string[];
  modelHealth: Record<string, ProviderAccountModelHealthItem>;
  readonly?: boolean;
}>();

const dashboardApi = useDashboardApi();
const dashboardInvalidation = useDashboardDataInvalidation();
const disabledModels = ref(new Set(props.initialDisabledModels));
const togglingModels = ref(new Set<string>());
const expanded = ref(false);
const visibleCount = 5;

watch(
  () => props.initialDisabledModels,
  (models) => {
    disabledModels.value = new Set(models);
  }
);

const enabledCount = computed(() => props.supportedModels.length - disabledModels.value.size);
const hasMore = computed(() => props.supportedModels.length > visibleCount);
const sortedModels = computed(() => [...props.supportedModels].sort((a, b) => modelSortWeight(a) - modelSortWeight(b) || compareModelIds(a, b)));
const visibleModels = computed(() => (expanded.value ? sortedModels.value : sortedModels.value.slice(0, visibleCount)));
const hiddenCount = computed(() => props.supportedModels.length - visibleCount);

function modelSortWeight(model: string): number {
  const status = props.modelHealth[model]?.status;
  if (status === "failed") return 0;
  if (status === "half_open") return 1;
  if (status === "degraded") return 2;
  return 3;
}

function modelHealthLabel(model: string): string | null {
  const health = props.modelHealth[model];
  if (!health || health.status === "active") return null;
  if (health.status === "failed") return `Failed (${health.consecutiveErrors})`;
  if (health.status === "half_open") return `Recovering (${health.consecutiveErrors})`;
  if (health.status === "degraded") return `Degraded (${health.consecutiveErrors})`;
  return null;
}

function modelButtonTitle(model: string): string {
  const action = disabledModels.value.has(model) ? `Enable ${model}` : `Disable ${model}`;
  const health = modelHealthLabel(model);
  return health ? `${health}. ${action}` : action;
}

function modelButtonClass(model: string): string {
  if (disabledModels.value.has(model)) return "border border-border/60 bg-transparent text-muted-foreground/60 line-through";
  const status = props.modelHealth[model]?.status;
  if (status === "failed") return "border border-red-500/45 bg-transparent text-red-600";
  if (status === "half_open") return "border border-yellow-500/45 bg-transparent text-yellow-700";
  if (status === "degraded") return "border border-yellow-500/45 bg-transparent text-yellow-700";
  return "border border-border bg-transparent text-foreground hover:bg-muted/30";
}

async function toggleModel(model: string) {
  if (props.readonly) return;
  const currentlyEnabled = !disabledModels.value.has(model);
  const enabled = !currentlyEnabled;
  const previous = new Set(disabledModels.value);
  const next = new Set(disabledModels.value);

  if (enabled) next.delete(model);
  else next.add(model);

  disabledModels.value = next;
  togglingModels.value = new Set(togglingModels.value).add(model);

  try {
    const result = await dashboardApi.accounts.setAccountModelEnabled({ accountId: props.accountId, modelId: model, enabled });
    if (!result.success) throw new Error(result.error);
    dashboardInvalidation.patchDisabledModels(props.provider, props.accountId, Array.from(disabledModels.value));
    dashboardInvalidation.clearAccountDependentOptions();
  } catch {
    disabledModels.value = previous;
  } finally {
    const pending = new Set(togglingModels.value);
    pending.delete(model);
    togglingModels.value = pending;
  }
}
</script>

<template>
  <div v-if="supportedModels.length" class="mt-3 space-y-2 border-t pt-3">
    <div class="flex items-center justify-between gap-2">
      <span class="text-xs font-medium text-muted-foreground">Model Access</span>
      <span class="text-xs text-muted-foreground">{{ enabledCount }}/{{ supportedModels.length }}</span>
    </div>
    <div class="flex flex-wrap gap-1.5">
      <button
        v-for="model in visibleModels"
        :key="model"
        type="button"
        :disabled="togglingModels.has(model) || readonly"
        :title="modelButtonTitle(model)"
        :class="[
          'inline-flex cursor-pointer items-center rounded-md px-2 py-0.5 font-mono text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
          modelButtonClass(model),
        ]"
        @click="toggleModel(model)"
      >
        {{ model }}
      </button>
      <button v-if="hasMore" type="button" class="inline-flex cursor-pointer items-center rounded-md border border-border bg-transparent px-2 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" @click="expanded = !expanded">
        {{ expanded ? 'Show less' : `+${hiddenCount} more` }}
      </button>
    </div>
  </div>
</template>
