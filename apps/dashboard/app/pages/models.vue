<script setup lang="ts">
import { MODEL_FAMILY_SORT_ORDER, categorizeModelFamily } from "../../lib/model-families";
import { compareModelEntries } from "../../lib/model-sort";
import type { ModelFamilyCounts } from "../../lib/navigation";
import { buildDayKeys, buildEmptyModelStats, buildHourKeys, MODEL_DURATION_LOOKBACK_HOURS, MODEL_STATS_DAYS, type ModelStats } from "../../lib/model-stats";
import { costEntries, formatCostPoints, type ModelCost } from "../../lib/model-cost";
import { getProviderLabel } from "../../lib/provider-accounts";

definePageMeta({ middleware: "auth", layout: "dashboard" });

const route = useRoute();
const api = useApi();
const { isAuditMode } = useAudit();
const invalidation = useInvalidate();

type ModelListItem = Awaited<ReturnType<typeof api.models.list>>[number];
const MODEL_STATS_BATCH_SIZE = 24;
const MODEL_STATS_POLL_MS = 30_000;
const MODEL_STATS_ROOT_MARGIN = "600px 0px";
const HIGHLIGHT_DURATION_MS = 2500;

const { data, error } = useCachedData(dataKeys.models, () => api.models.list({ includeStats: false }));
const models = computed<ModelListItem[]>(() => data.value ?? []);
const emptyModelStats = buildEmptyModelStats(buildDayKeys(MODEL_STATS_DAYS), buildHourKeys(MODEL_DURATION_LOOKBACK_HOURS));
const modelStatsById = shallowReactive<Record<string, ModelStats>>({});
const modelStatsCursorById = shallowReactive<Record<string, string>>({});
const pendingModelId = ref<string | null>(null);
const copiedModelId = ref<string | null>(null);
const modelFamilyCountsOverride = useState<ModelFamilyCounts | null>(stateKeys.modelFamilyCountsOverride, () => null);
const modelsRoot = ref<HTMLElement | null>(null);
const visibleModelIds = reactive(new Set<string>());
const intersectingModelIds = new Set<string>();
const highlightedModelId = ref<string | null>(null);
let highlightTimer: ReturnType<typeof setTimeout> | null = null;
const queuedModelStatsIds = new Set<string>();
const forceQueuedModelStatsIds = new Set<string>();
const loadingModelStatsIds = new Set<string>();
let modelStatsQueueTimer: ReturnType<typeof setTimeout> | null = null;
let modelStatsPollTimer: ReturnType<typeof setInterval> | null = null;
let statsObserver: IntersectionObserver | null = null;

const enabledModelCount = computed(() => models.value.filter((model) => model.isEnabled).length);
const modelSections = computed(() => {
  const groupedModels = new Map<string, ModelListItem[]>();

  for (const model of models.value) {
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
  statsObserver = new IntersectionObserver((entries) => {
    const visibleIds: string[] = [];

    for (const entry of entries) {
      const modelId = (entry.target as HTMLElement).dataset.modelId;
      if (!modelId) continue;

      if (!entry.isIntersecting) {
        intersectingModelIds.delete(modelId);
        continue;
      }

      visibleModelIds.add(modelId);
      intersectingModelIds.add(modelId);
      visibleIds.push(modelId);
    }

    if (visibleIds.length > 0) queueModelStatsLoad(visibleIds);
  }, { rootMargin: MODEL_STATS_ROOT_MARGIN });

  observeModelCards();
  startModelStatsPolling();
});

onBeforeUnmount(() => {
  statsObserver?.disconnect();
  statsObserver = null;
  stopModelStatsPolling();
  if (modelStatsQueueTimer) clearTimeout(modelStatsQueueTimer);
  if (highlightTimer) {
    clearTimeout(highlightTimer);
    highlightTimer = null;
  }
});

function queueModelStatsLoad(modelIds: Iterable<string>, options: { force?: boolean } = {}) {
  if (!import.meta.client) return;

  for (const modelId of modelIds) {
    if (!options.force && modelStatsById[modelId]) continue;
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
    .filter((modelId) => options.force || !modelStatsById[modelId]);

  if (requestedModelIds.length === 0) return;

  for (const modelId of requestedModelIds) loadingModelStatsIds.add(modelId);

  try {
    const response = await api.models.stats({
      models: requestedModelIds,
      cursors: Object.fromEntries(requestedModelIds.map((modelId) => [modelId, modelStatsCursorById[modelId] ?? ""])),
    });
    for (const [modelId, cursor] of Object.entries(response.cursors)) modelStatsCursorById[modelId] = cursor;
    if (response.stats) {
      for (const [modelId, stats] of Object.entries(response.stats)) modelStatsById[modelId] = stats;
    }
  } catch (error) {
    console.error("Failed to load model stats:", error);
  } finally {
    for (const modelId of requestedModelIds) loadingModelStatsIds.delete(modelId);
  }
}

function observeModelCards() {
  if (!import.meta.client || !statsObserver) return;
  const root = modelsRoot.value;
  if (!root) return;

  statsObserver.disconnect();
  intersectingModelIds.clear();

  for (const element of root.querySelectorAll<HTMLElement>("[data-model-id]")) {
    statsObserver.observe(element);
  }
}

function startModelStatsPolling() {
  if (!import.meta.client || modelStatsPollTimer) return;

  modelStatsPollTimer = setInterval(() => {
    if (document.hidden) return;
    queueModelStatsLoad(Array.from(intersectingModelIds), { force: true });
  }, MODEL_STATS_POLL_MS);
}

function stopModelStatsPolling() {
  if (!modelStatsPollTimer) return;

  clearInterval(modelStatsPollTimer);
  modelStatsPollTimer = null;
}

function pruneModelStats() {
  const availableModelIds = new Set(models.value.map((model) => model.id));

  for (const modelId of Object.keys(modelStatsById)) {
    if (!availableModelIds.has(modelId)) Reflect.deleteProperty(modelStatsById, modelId);
  }

  for (const modelId of Object.keys(modelStatsCursorById)) {
    if (!availableModelIds.has(modelId)) Reflect.deleteProperty(modelStatsCursorById, modelId);
  }

  for (const modelId of forceQueuedModelStatsIds) {
    if (!availableModelIds.has(modelId)) forceQueuedModelStatsIds.delete(modelId);
  }

  for (const modelId of visibleModelIds) {
    if (!availableModelIds.has(modelId)) visibleModelIds.delete(modelId);
  }

  for (const modelId of intersectingModelIds) {
    if (!availableModelIds.has(modelId)) intersectingModelIds.delete(modelId);
  }
}

watch(models, async () => {
  pruneModelStats();
  await nextTick();
  observeModelCards();
}, { immediate: true });

watch(modelSections, async () => {
  await nextTick();
  observeModelCards();
}, { immediate: true });

function getFamilyAnchorId(family: string) {
  if (family === "OpenAI") return "openai-models";
  if (family === "Anthropic") return "anthropic-models";
  if (family === "Google") return "google-models";
  if (family === "Meta") return "meta-models";
  if (family === "Mistral") return "mistral-models";
  if (family === "Qwen") return "qwen-models";
  if (family === "DeepSeek") return "deepseek-models";
  if (family === "Moonshot") return "moonshot-models";
  if (family === "MiniMax") return "minimax-models";
  if (family === "Xiaomi") return "xiaomi-models";
  if (family === "xAI") return "xai-models";
  if (family === "Z.AI") return "zai-models";
  if (family === "StepFun") return "stepfun-models";
  return "other-models";
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

function modelCostSummary(cost: ModelCost) {
  return `${formatCostPoints(cost.input ?? 0)}/${formatCostPoints(cost.output ?? 0)}`;
}

async function setModelEnabled(model: ModelListItem, enabled: boolean) {
  if (isAuditMode.value) return;
  pendingModelId.value = model.id;
  const previousValue = model.isEnabled;
  updateModelEnabled(model.id, enabled);

  try {
    const result = await api.models.setEnabled({ modelId: model.id, enabled });
    if (!result.success) throw new Error(result.error);
    invalidation.patchModelEnabled(result.data.model, result.data.enabled);
    void invalidation.invalidateModelAvailability();
  } catch (error) {
    updateModelEnabled(model.id, previousValue);
    console.error(error);
  } finally {
    pendingModelId.value = null;
  }
}

function decodeModelHash(hash: string): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const id = raw.startsWith("model-") ? raw.slice("model-".length) : raw;
  if (!id) return null;

  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
}

watch(
  () => route.hash,
  (raw) => {
    if (!import.meta.client) return;
    const hashRaw = raw.startsWith("#") ? raw.slice(1) : raw;
    if (!hashRaw.startsWith("model-")) return;
    const id = decodeModelHash(raw);
    if (!id) return;
    if (highlightedModelId.value === id) return;

    highlightedModelId.value = id;
    if (highlightTimer) clearTimeout(highlightTimer);
    highlightTimer = setTimeout(() => {
      highlightedModelId.value = null;
      highlightTimer = null;
    }, HIGHLIGHT_DURATION_MS);

    if (route.path === "/models" && typeof window !== "undefined") {
      window.history.replaceState(window.history.state, "", "/models");
    }
  },
  { immediate: true }
);
</script>

<template>
  <div ref="modelsRoot" class="space-y-6">
    <div class="dashboard-header-divider">
      <div class="flex flex-wrap items-center gap-2">
        <h2 class="text-xl font-semibold">Models</h2>
        <UiBadge variant="outline">{{ enabledModelCount }}/{{ models.length }}</UiBadge>
      </div>
    </div>

    <DataNotice :error="error" />
    <div v-if="models.length > 0" class="space-y-6">
      <section v-for="section in modelSections" :id="section.anchorId" :key="section.name" class="scroll-mt-24 space-y-4 md:space-y-2">
        <div class="flex items-center gap-2">
          <h3 class="text-sm font-semibold">{{ section.name }}</h3>
          <UiBadge variant="outline" class="text-[10px] font-normal">{{ section.models.length }} models</UiBadge>
        </div>
        <div class="dashboard-card-grid">
          <UiCard
            v-for="model in section.models"
            :id="`model-${model.id}`"
            :key="model.id"
            :data-model-id="model.id"
            :class="`flex h-full flex-col scroll-mt-20 bg-transparent [contain-intrinsic-size:auto_12rem] [content-visibility:auto] transition-[border-color,box-shadow] duration-[1800ms] ease-out${model.isEnabled === false ? ' opacity-65' : ''}${highlightedModelId === model.id ? ' border-primary shadow-[0_0_0_3px_var(--primary)]' : ' border-border shadow-none'}`"
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
                    <NuxtLink :to="`/play?model=${encodeURIComponent(model.id)}&compare=auto`" class="inline-flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground" aria-label="Try in Playground">
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

              <div class="mt-1 flex items-start justify-between gap-2">
                <div class="flex min-w-0 flex-wrap items-center gap-1.5">
                  <UiBadge
                    v-for="provider in model.providers"
                    :key="provider"
                    variant="outline"
                    class="text-[10px] font-normal"
                  >
                    {{ getProviderLabel(provider) }}
                  </UiBadge>
                </div>
                <UiTooltip v-if="model.cost" side="left">
                  <span class="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted/50 px-1.5 py-0.5 font-mono text-[10px] font-normal leading-none text-muted-foreground tabular-nums">
                    <UiIcon name="i-lucide-coins" class="size-3" />
                    {{ modelCostSummary(model.cost) }}
                  </span>
                  <template #content>
                    <div class="space-y-0.5">
                      <p class="font-medium">Cost in points per 1M tokens</p>
                      <p v-for="entry in costEntries(model.cost)" :key="entry.label">
                        {{ entry.label }}: {{ formatCostPoints(entry.value) }}
                      </p>
                    </div>
                  </template>
                </UiTooltip>
              </div>
            </UiCardHeader>

            <UiCardContent class="flex flex-1 flex-col pt-0">
              <div class="mt-auto space-y-3">
                <ModelFeatureBadges :model="model" />
                <ModelStatsPanel
                  v-if="visibleModelIds.has(model.id)"
                  :stats="model.stats ?? emptyModelStats"
                  :stats-map="modelStatsById"
                  :model-id="model.id"
                  :label="model.id"
                  :disabled="!model.isEnabled"
                  compact
                  :animate-deltas="false"
                />
                <div v-else class="min-h-[7.75rem]" aria-hidden="true" />
              </div>
            </UiCardContent>
          </UiCard>
        </div>
      </section>
    </div>
  </div>
</template>
