<script setup lang="ts">
import { MODEL_FAMILY_SORT_ORDER, categorizeModelFamily } from "../../../lib/model-families";
import { compareModelEntries } from "../../../lib/model-sort";
import type { ModelFamilyCounts } from "../../../lib/navigation";
import { buildDayKeys, buildEmptyModelStats, buildHourKeys, MODEL_DURATION_LOOKBACK_HOURS, MODEL_STATS_DAYS, type ModelStats } from "../../../lib/model-stats";
import { getProviderLabel } from "../../../lib/provider-accounts";

definePageMeta({ middleware: "auth", layout: "dashboard" });

const dashboardApi = useDashboardApi();
const { isAuditMode } = useDashboardAudit();
const dashboardInvalidation = useDashboardDataInvalidation();
const nuxtApp = useNuxtApp();

type ModelListItem = Awaited<ReturnType<typeof dashboardApi.models.list>>[number];
const MODEL_STATS_BATCH_SIZE = 24;
const MODEL_STATS_POLL_MS = 30_000;

const cachedModelsBeforePageLoad = useNuxtData<ModelListItem[]>(dashboardInvalidation.keys.models).data.value !== undefined;
const shouldRefreshCachedModelsOnMount = import.meta.client && !nuxtApp.isHydrating && cachedModelsBeforePageLoad;
const { data, error, refresh } = await useAsyncData(dashboardInvalidation.keys.models, () => dashboardApi.models.list({ includeStats: false }));
const models = computed<ModelListItem[]>(() => data.value ?? []);
const emptyModelStats = buildEmptyModelStats(buildDayKeys(MODEL_STATS_DAYS), buildHourKeys(MODEL_DURATION_LOOKBACK_HOURS));
const modelStatsById = ref<Record<string, ModelStats>>({});
const modelStatsCursorById = ref<Record<string, string>>({});
const availableProviders = computed(() => {
  const entries = new Map<string, string>();

  for (const model of models.value) {
    for (const provider of model.providers) {
      entries.set(provider, getProviderLabel(provider));
    }
  }

  return Array.from(entries, ([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label));
});
const activeProviders = ref<string[]>([]);
const pendingModelId = ref<string | null>(null);
const copiedModelId = ref<string | null>(null);
const modelFamilyCountsOverride = useState<ModelFamilyCounts | null>("dashboard-model-family-counts-override", () => null);
const queuedModelStatsIds = new Set<string>();
const forceQueuedModelStatsIds = new Set<string>();
const loadingModelStatsIds = new Set<string>();
let modelStatsQueueTimer: ReturnType<typeof setTimeout> | null = null;
let modelStatsPollTimer: ReturnType<typeof setInterval> | null = null;

watchEffect(() => {
  if (activeProviders.value.length === 0 && availableProviders.value.length > 0) {
    activeProviders.value = availableProviders.value.map((provider) => provider.id);
  }
});

const allSelected = computed(() => activeProviders.value.length === availableProviders.value.length);
const filteredModels = computed(() => {
  const active = new Set(activeProviders.value);
  return models.value.filter((model) => model.providers.some((provider) => active.has(provider)));
});
const enabledModelCount = computed(() => models.value.filter((model) => model.isEnabled).length);
const modelSections = computed(() => {
  const groupedModels = new Map<string, ModelListItem[]>();

  for (const model of filteredModels.value) {
    const family = categorizeModelFamily(model.family);
    const familyModels = groupedModels.get(family) ?? [];
    familyModels.push(model);
    groupedModels.set(family, familyModels);
  }

  for (const familyModels of groupedModels.values()) {
    familyModels.sort(compareModelEntries);
  }

  return MODEL_FAMILY_SORT_ORDER
    .map((family) => ({
      name: family,
      anchorId: getFamilyAnchorId(family),
      models: groupedModels.get(family) ?? [],
    }))
    .filter((section) => section.models.length > 0);
});

watchEffect(() => {
  modelFamilyCountsOverride.value = Object.fromEntries(
    modelSections.value.map((section) => [section.anchorId, section.models.length])
  );
});

onUnmounted(() => {
  modelFamilyCountsOverride.value = null;
});

onMounted(() => {
  startModelStatsPolling();

  if (shouldRefreshCachedModelsOnMount) {
    void refreshModels();
  }
});

onBeforeUnmount(() => {
  stopModelStatsPolling();
  if (modelStatsQueueTimer) clearTimeout(modelStatsQueueTimer);
});

async function refreshModels() {
  await refresh();
  queueModelStatsLoad(models.value.map((model) => model.id), { force: true });
}

function getModelStats(model: ModelListItem): ModelStats {
  return modelStatsById.value[model.id] ?? model.stats ?? emptyModelStats;
}

function queueModelStatsLoad(modelIds: Iterable<string>, options: { force?: boolean } = {}) {
  if (!import.meta.client) return;

  for (const modelId of modelIds) {
    if (!options.force && modelStatsById.value[modelId]) continue;
    if (loadingModelStatsIds.has(modelId)) continue;
    queuedModelStatsIds.add(modelId);
    if (options.force) forceQueuedModelStatsIds.add(modelId);
  }

  if (queuedModelStatsIds.size === 0 || modelStatsQueueTimer) return;
  modelStatsQueueTimer = setTimeout(() => {
    modelStatsQueueTimer = null;
    void flushQueuedModelStats();
  }, 80);
}

async function flushQueuedModelStats() {
  const modelIds = Array.from(queuedModelStatsIds).slice(0, MODEL_STATS_BATCH_SIZE);
  for (const modelId of modelIds) queuedModelStatsIds.delete(modelId);
  const force = modelIds.some((modelId) => forceQueuedModelStatsIds.has(modelId));
  for (const modelId of modelIds) forceQueuedModelStatsIds.delete(modelId);

  await loadModelStats(modelIds, { force });

  if (queuedModelStatsIds.size > 0) {
    modelStatsQueueTimer = setTimeout(() => {
      modelStatsQueueTimer = null;
      void flushQueuedModelStats();
    }, 80);
  }
}

async function loadModelStats(modelIds: string[], options: { force?: boolean } = {}) {
  const availableModelIds = new Set(models.value.map((model) => model.id));
  const requestedModelIds = Array.from(new Set(modelIds))
    .filter((modelId) => availableModelIds.has(modelId))
    .filter((modelId) => !loadingModelStatsIds.has(modelId))
    .filter((modelId) => options.force || !modelStatsById.value[modelId]);

  if (requestedModelIds.length === 0) return;

  for (const modelId of requestedModelIds) loadingModelStatsIds.add(modelId);

  try {
    const response = await dashboardApi.models.stats({
      models: requestedModelIds,
      cursors: Object.fromEntries(requestedModelIds.map((modelId) => [modelId, modelStatsCursorById.value[modelId] ?? ""])),
    });
    modelStatsCursorById.value = { ...modelStatsCursorById.value, ...response.cursors };
    if (response.stats) modelStatsById.value = { ...modelStatsById.value, ...response.stats };
  } catch (error) {
    console.error("Failed to load model stats:", error);
  } finally {
    for (const modelId of requestedModelIds) loadingModelStatsIds.delete(modelId);
  }
}

function startModelStatsPolling() {
  if (!import.meta.client || modelStatsPollTimer) return;

  modelStatsPollTimer = setInterval(() => {
    if (document.hidden) return;
    queueModelStatsLoad(models.value.map((model) => model.id), { force: true });
  }, MODEL_STATS_POLL_MS);
}

function stopModelStatsPolling() {
  if (!modelStatsPollTimer) return;

  clearInterval(modelStatsPollTimer);
  modelStatsPollTimer = null;
}

function pruneModelStats() {
  const availableModelIds = new Set(models.value.map((model) => model.id));
  modelStatsById.value = Object.fromEntries(Object.entries(modelStatsById.value).filter(([modelId]) => availableModelIds.has(modelId)));
  modelStatsCursorById.value = Object.fromEntries(Object.entries(modelStatsCursorById.value).filter(([modelId]) => availableModelIds.has(modelId)));
  for (const modelId of forceQueuedModelStatsIds) {
    if (!availableModelIds.has(modelId)) forceQueuedModelStatsIds.delete(modelId);
  }
}

watch(models, () => {
  pruneModelStats();
  queueModelStatsLoad(models.value.map((model) => model.id));
}, { immediate: true });

function getFamilyAnchorId(family: string) {
  if (family === "OpenAI") return "openai-models";
  if (family === "Anthropic") return "anthropic-models";
  if (family === "Google") return "google-models";
  if (family === "Meta") return "meta-models";
  if (family === "Mistral") return "mistral-models";
  if (family === "Qwen") return "qwen-models";
  if (family === "DeepSeek") return "deepseek-models";
  if (family === "Kimi") return "kimi-models";
  if (family === "MiniMax") return "minimax-models";
  if (family === "Xiaomi") return "xiaomi-models";
  if (family === "xAI") return "xai-models";
  if (family === "Z.AI") return "zai-models";
  return "other-models";
}

function toggleProvider(providerId: string) {
  if (providerId === "all") {
    activeProviders.value = allSelected.value ? [] : availableProviders.value.map((provider) => provider.id);

    if (activeProviders.value.length === 0 && availableProviders.value[0]) {
      activeProviders.value = [availableProviders.value[0].id];
    }

    return;
  }

  if (allSelected.value) {
    activeProviders.value = [providerId];
    return;
  }

  if (activeProviders.value.includes(providerId)) {
    const next = activeProviders.value.filter((id) => id !== providerId);

    if (next.length > 0) {
      activeProviders.value = next;
    }

    return;
  }

  activeProviders.value = [...activeProviders.value, providerId];
}

async function copyModelId(modelId: string) {
  await navigator.clipboard.writeText(modelId);
  copiedModelId.value = modelId;
  window.setTimeout(() => {
    if (copiedModelId.value === modelId) copiedModelId.value = null;
  }, 2000);
}

function updateModelEnabled(modelId: string, enabled: boolean) {
  if (!data.value) return;
  data.value = data.value.map((model) => (model.id === modelId ? { ...model, isEnabled: enabled } : model));
}

async function setModelEnabled(model: ModelListItem, enabled: boolean) {
  if (isAuditMode.value) return;
  pendingModelId.value = model.id;
  const previousValue = model.isEnabled;
  updateModelEnabled(model.id, enabled);

  try {
    const result = await dashboardApi.models.setEnabled({ modelId: model.id, enabled });
    if (!result.success) throw new Error(result.error);
    dashboardInvalidation.patchModelEnabled(result.data.model, result.data.enabled);
    void dashboardInvalidation.invalidateModelAvailability();
  } catch (error) {
    updateModelEnabled(model.id, previousValue);
    console.error(error);
  } finally {
    pendingModelId.value = null;
  }
}
</script>

<template>
  <div class="space-y-6">
    <div class="dashboard-header-divider">
      <div class="flex flex-wrap items-center gap-2">
        <h2 class="text-xl font-semibold">Models</h2>
        <UiBadge variant="outline">{{ enabledModelCount }}/{{ models.length }}</UiBadge>
      </div>
    </div>

    <DashboardDataNotice :error="error" />
    <div v-if="models.length > 0" class="space-y-4 md:space-y-2">
      <div class="flex flex-wrap gap-1.5 pb-2">
        <button
          type="button"
          :class="[
            'inline-flex h-7 cursor-pointer items-center justify-center rounded-md border px-2.5 text-xs font-medium transition-colors',
            allSelected ? 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/15' : 'border-input bg-input/30 hover:bg-input/50',
          ]"
          @click="toggleProvider('all')"
        >
          All
        </button>
        <button
          v-for="provider in availableProviders"
          :key="provider.id"
          type="button"
          :class="[
            'inline-flex h-7 cursor-pointer items-center justify-center rounded-md border px-2.5 text-xs font-medium transition-colors',
            activeProviders.includes(provider.id) ? 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/15' : 'border-input bg-input/30 hover:bg-input/50',
          ]"
          @click="toggleProvider(provider.id)"
        >
          {{ provider.label }}
        </button>
      </div>

      <div class="space-y-6">
        <section v-for="section in modelSections" :id="section.anchorId" :key="section.name" class="scroll-mt-24 space-y-4 md:space-y-2">
          <div class="flex items-center gap-2">
            <h3 class="text-sm font-semibold">{{ section.name }}</h3>
            <UiBadge variant="outline" class="text-[10px] font-normal">{{ section.models.length }} models</UiBadge>
          </div>
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-[repeat(auto-fit,minmax(min(20rem,100%),1fr))]">
            <UiCard
              v-for="model in section.models"
              :key="model.id"
              class="flex h-full flex-col bg-transparent transition-colors"
              :class="model.isEnabled === false ? 'opacity-65' : ''"
            >
              <UiCardHeader class="pb-1">
                <div class="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
                  <UiTooltip text="Copy ID" class="max-w-96 break-all font-mono">
                    <button
                      type="button"
                      class="-m-1 flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md p-1 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      :aria-label="`Copy model ID ${model.id}`"
                      @click="copyModelId(model.id)"
                    >
                      <span class="flex size-3 shrink-0 items-center justify-center">
                        <UiIcon :name="copiedModelId === model.id ? 'i-lucide-check' : 'i-lucide-copy'" class="size-3" />
                      </span>
                      <span class="min-w-0 flex-1 overflow-hidden break-all font-mono text-sm font-semibold leading-5 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]">
                        {{ model.id }}
                      </span>
                    </button>
                  </UiTooltip>
                  <div class="mt-0.5 flex shrink-0 items-center gap-1.5">
                    <UiTooltip v-if="model.isEnabled" text="Playground">
                      <NuxtLink :to="`/dashboard/playground?model=${encodeURIComponent(model.id)}`" class="inline-flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground" aria-label="Try in Playground">
                        <UiIcon name="i-lucide-flask-conical" class="size-3" />
                      </NuxtLink>
                    </UiTooltip>
                    <span class="w-5 text-right text-[11px] leading-none text-muted-foreground">
                      {{ model.isEnabled ? 'On' : 'Off' }}
                    </span>
                    <UiSwitch
                      :model-value="model.isEnabled"
                      :disabled="pendingModelId === model.id || isAuditMode"
                      :title="model.isEnabled ? 'Disable' : 'Enable'"
                      @update:model-value="setModelEnabled(model, $event)"
                    />
                  </div>
                </div>

                <div class="mt-1 flex flex-wrap items-center gap-1.5">
                  <UiBadge
                    v-for="provider in model.providers"
                    :key="provider"
                    variant="outline"
                    :class="[
                      'text-[10px] font-normal',
                      activeProviders.includes(provider) ? '' : 'border-border/60 text-muted-foreground opacity-70',
                    ]"
                  >
                    {{ getProviderLabel(provider) }}
                  </UiBadge>
                </div>
              </UiCardHeader>

              <UiCardContent class="flex flex-1 flex-col pt-0">
                <div class="mt-auto space-y-3">
                  <ModelFeatureBadges :meta="model.meta" />
                  <ModelStatsPanel :stats="getModelStats(model)" :label="model.id" :disabled="!model.isEnabled" compact :animate-deltas="false" />
                </div>
              </UiCardContent>
            </UiCard>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>
