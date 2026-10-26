<script setup lang="ts">
import { SORT_ORDER, anchorId } from "@opendum/models/ranking";
import { decodeHash, errorText, failureText, settle } from "~~/lib/settle";
import { compareEntries } from "@opendum/models/sort";
import { dayKeys, emptyStats, hourKeys, LOOKBACK_HOURS, MODEL_STATS_DAYS, type ModelStats } from "@opendum/models/stats";
import { costEntries, costPoints, type ModelCost } from "~~/lib/model-cost";
import type { UsageData } from "@opendum/providers/contract";
import { labelOf } from "@opendum/providers/provider-accounts";

definePageMeta({ middleware: "auth", layout: "web" });

const route = useRoute();
const api = useApi();
const { isAuditMode } = useAudit();
const invalidation = useInvalidate();

type ModelListItem = Awaited<ReturnType<typeof api.models.list>>[number];
const STATS_BATCH_SIZE = 24;
const STATS_ROOT_MARGIN = "600px 0px";
const HIGHLIGHT_DURATION_MS = 2500;

const { data, error } = useAsyncData(dataKeys.models, () => api.models.list({ includeStats: false }));
const models = computed<ModelListItem[]>(() => data.value ?? []);

function isLinked(model: ModelListItem) {
  return model.available !== false;
}

function isActive(model: ModelListItem) {
  return isLinked(model) && model.isEnabled;
}
const customModelIds = computed(() => new Set(models.value.filter((model) => model.custom).map((model) => model.id)));
const emptyModelStats = emptyStats(dayKeys(MODEL_STATS_DAYS), hourKeys(LOOKBACK_HOURS));
const statsById = shallowReactive<Record<string, ModelStats>>({});
const pendingModelId = ref<string | null>(null);
const copiedModelId = ref<string | null>(null);
const modelsRoot = ref<HTMLElement | null>(null);
const visibleModelIds = reactive(new Set<string>());
const intersectingModelIds = new Set<string>();
const highlightedModelId = ref<string | null>(null);
let highlightTimer: ReturnType<typeof setTimeout> | null = null;
const queuedStatsIds = new Set<string>();
const forceStatsIds = new Set<string>();
const loadingStatsIds = new Set<string>();
let statsTimer: ReturnType<typeof setTimeout> | null = null;
let statsObserver: IntersectionObserver | null = null;

const enabledModelCount = computed(() => models.value.filter((model) => model.available !== false && model.isEnabled).length);
const modelSections = computed(() => {
  const groupedModels = new Map<string, ModelListItem[]>();

  for (const model of models.value) {
    const family = model.family && model.family.trim().length > 0 ? model.family : "Others";
    const familyModels = groupedModels.get(family) ?? [];
    familyModels.push(model);
    groupedModels.set(family, familyModels);
  }

  for (const familyModels of groupedModels.values()) {
    familyModels.sort(compareEntries);
  }

  const rankedFamilies = SORT_ORDER.filter((family) => family !== "Others");
  const rankedSet = new Set<string>(rankedFamilies);

  const sections = rankedFamilies
    .map((family) => ({
      name: family,
      anchorId: anchorId(family),
      models: groupedModels.get(family) ?? [],
    }))
    .filter((section) => section.models.length > 0);

  const tailSections = [...groupedModels.keys()]
    .filter((family) => family !== "Others" && !rankedSet.has(family))
    .sort((a, b) => a.localeCompare(b))
    .map((family) => ({
      name: family,
      anchorId: anchorId(family),
      models: groupedModels.get(family) ?? [],
    }));

  const otherModels = groupedModels.get("Others") ?? [];
  if (otherModels.length > 0) {
    tailSections.push({ name: "Others", anchorId: "other-models-misc", models: otherModels });
  }

  if (tailSections.length > 0) {
    const firstTail = tailSections[0];
    if (firstTail) {
      sections.push({ ...firstTail, anchorId: "other-models" });
    }
    sections.push(...tailSections.slice(1));
  }

  return sections;
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

    if (visibleIds.length > 0) queueStats(visibleIds);
  }, { rootMargin: STATS_ROOT_MARGIN });

  observeCards();
});

onBeforeUnmount(() => {
  statsObserver?.disconnect();
  statsObserver = null;
  if (statsTimer) clearTimeout(statsTimer);
  if (highlightTimer) {
    clearTimeout(highlightTimer);
    highlightTimer = null;
  }
});

function queueStats(modelIds: Iterable<string>, options: { force?: boolean } = {}) {
  if (!import.meta.client) return;

  for (const modelId of modelIds) {
    if (!options.force && statsById[modelId]) continue;
    if (loadingStatsIds.has(modelId)) continue;
    queuedStatsIds.add(modelId);
    if (options.force) forceStatsIds.add(modelId);
  }

  if (queuedStatsIds.size === 0 || statsTimer) return;
  statsTimer = setTimeout(() => {
    statsTimer = null;
    void flushStats();
  }, 80);
}

async function flushStats() {
  const modelIds = Array.from(queuedStatsIds).slice(0, STATS_BATCH_SIZE);
  for (const modelId of modelIds) queuedStatsIds.delete(modelId);
  const force = modelIds.some((modelId) => forceStatsIds.has(modelId));
  for (const modelId of modelIds) forceStatsIds.delete(modelId);

  await loadStats(modelIds, { force });

  if (queuedStatsIds.size > 0) {
    statsTimer = setTimeout(() => {
      statsTimer = null;
      void flushStats();
    }, 80);
  }
}

async function loadStats(modelIds: string[], options: { force?: boolean } = {}) {
  const availableModelIds = new Set(models.value.filter((model) => model.available !== false).map((model) => model.id));
  const requestedModelIds = Array.from(new Set(modelIds))
    .filter((modelId) => availableModelIds.has(modelId) && !customModelIds.value.has(modelId))
    .filter((modelId) => !loadingStatsIds.has(modelId))
    .filter((modelId) => options.force || !statsById[modelId]);

  if (requestedModelIds.length === 0) return;

  for (const modelId of requestedModelIds) loadingStatsIds.add(modelId);

  const loaded = await settle(() => api.models.stats({ models: requestedModelIds }));
  if (loaded.ok) {
    for (const [modelId, stats] of Object.entries(loaded.value)) statsById[modelId] = stats;
  } else {
    console.error("Failed to load model stats:", loaded.error);
  }
  for (const modelId of requestedModelIds) loadingStatsIds.delete(modelId);
}

function observeCards() {
  if (!import.meta.client || !statsObserver) return;
  const root = modelsRoot.value;
  if (!root) return;

  statsObserver.disconnect();
  intersectingModelIds.clear();

  for (const element of root.querySelectorAll<HTMLElement>("[data-model-id]")) {
    statsObserver.observe(element);
  }
}

function applyUsage(data: UsageData) {
  for (const [modelId, stats] of Object.entries(data.modelStats)) statsById[modelId] = stats;
}

useLiveEvent("usage", applyUsage);

function pruneStats() {
  const availableModelIds = new Set(models.value.filter((model) => model.available !== false).map((model) => model.id));

  for (const modelId of Object.keys(statsById)) {
    if (!availableModelIds.has(modelId)) Reflect.deleteProperty(statsById, modelId);
  }

  for (const modelId of forceStatsIds) {
    if (!availableModelIds.has(modelId)) forceStatsIds.delete(modelId);
  }

  for (const modelId of visibleModelIds) {
    if (!availableModelIds.has(modelId)) visibleModelIds.delete(modelId);
  }

  for (const modelId of intersectingModelIds) {
    if (!availableModelIds.has(modelId)) intersectingModelIds.delete(modelId);
  }
}

watch(models, async () => {
  pruneStats();
  await nextTick();
  observeCards();
}, { immediate: true });

watch(modelSections, async () => {
  await nextTick();
  observeCards();
}, { immediate: true });

async function copyId(modelId: string) {
  await navigator.clipboard.writeText(modelId);
  copiedModelId.value = modelId;
  window.setTimeout(() => {
    if (copiedModelId.value === modelId) copiedModelId.value = null;
  }, 2000);
}

function applyEnabled(modelId: string, enabled: boolean) {
  if (!data.value) return;
  data.value = data.value.map((model) => (model.id === modelId ? { ...model, isEnabled: enabled } : model));
}

function costSummary(cost: ModelCost) {
  return `${costPoints(cost.input ?? 0)}/${costPoints(cost.output ?? 0)}`;
}

async function enableModel(model: ModelListItem, enabled: boolean) {
  if (isAuditMode.value || model.available === false) return;
  pendingModelId.value = model.id;
  const previousValue = model.isEnabled;
  applyEnabled(model.id, enabled);

  const updated = await settle(() => api.models.setEnabled({ modelId: model.id, enabled }));
  pendingModelId.value = null;
  if (updated.ok && updated.value.success) {
    invalidation.patchModelEnabled(updated.value.data.model, updated.value.data.enabled);
    void invalidation.invalidateModelAvailability();
  } else {
    applyEnabled(model.id, previousValue);
    console.error(updated.ok ? failureText(updated, "Failed to update model") : errorText(updated.error, "Failed to update model"));
  }
}

function hashModel(hash: string): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const id = raw.startsWith("model-") ? raw.slice("model-".length) : raw;
  if (!id) return null;

  return decodeHash(id);
}

watch(
  () => route.hash,
  (raw) => {
    if (!import.meta.client) return;
    const hashRaw = raw.startsWith("#") ? raw.slice(1) : raw;
    if (!hashRaw.startsWith("model-")) return;
    const id = hashModel(raw);
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
    <div class="web-header-divider">
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
        <div class="web-card-grid">
          <UiCard
            v-for="model in section.models"
            :id="`model-${model.id}`"
            :key="model.id"
            :data-model-id="model.id"
            :class="`flex h-full flex-col scroll-mt-20 bg-transparent [contain-intrinsic-size:auto_12rem] [content-visibility:auto] transition-[border-color,box-shadow] duration-[1800ms] ease-out${isLinked(model) ? (isActive(model) ? '' : ' opacity-65') : ' grayscale opacity-40'}${highlightedModelId === model.id ? ' border-primary shadow-[0_0_0_3px_var(--primary)]' : ' border-border shadow-none'}`"
          >
            <UiCardHeader class="pb-1">
              <div class="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
                <button
                  type="button"
                  :class="['-m-1 flex min-w-0 flex-1 items-center gap-1.5 rounded-md p-1 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2', isLinked(model) ? 'cursor-pointer' : 'cursor-default']"
                  :disabled="!isLinked(model)"
                  :aria-label="`Copy model ID ${model.id}`"
                  @click="copyId(model.id)"
                >
                  <span class="flex size-3 shrink-0 items-center justify-center">
                    <UiIcon :name="copiedModelId === model.id ? 'i-lucide-check' : 'i-lucide-copy'" class="size-3" />
                  </span>
                  <UiMarquee :text="model.id" class="flex-1 font-mono text-sm font-semibold leading-5" />
                </button>
                <div class="mt-0.5 flex shrink-0 items-center gap-1.5">
                  <NuxtLink v-if="!isLinked(model)" :to="`/play?model=${encodeURIComponent(model.id)}&compare=auto`" class="inline-flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground" aria-label="Try in Playground">
                    <UiIcon name="i-lucide-flask-conical" class="size-3" />
                  </NuxtLink>
                  <UiTooltip v-else text="Playground">
                    <NuxtLink :to="`/play?model=${encodeURIComponent(model.id)}&compare=auto`" class="inline-flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground" aria-label="Try in Playground">
                      <UiIcon name="i-lucide-flask-conical" class="size-3" />
                    </NuxtLink>
                  </UiTooltip>
                  <span class="w-5 text-right text-[11px] leading-none text-muted-foreground">
                    {{ isActive(model) ? 'On' : 'Off' }}
                  </span>
                  <UiSwitch
                    :model-value="isActive(model)"
                    :disabled="!isLinked(model) || pendingModelId === model.id || isAuditMode"
                    :title="isLinked(model) ? (model.isEnabled ? 'Disable' : 'Enable') : undefined"
                    @update:model-value="enableModel(model, $event)"
                  />
                </div>
              </div>

              <div class="mt-1 flex items-start justify-between gap-2">
                <div class="flex min-w-0 flex-wrap items-center gap-1.5">
                  <UiBadge
                    v-for="provider in model.providers"
                    :key="provider"
                    variant="outline"
                    :class="isLinked(model) ? 'text-[10px] font-normal' : 'text-[10px] font-normal border-border/60 text-muted-foreground opacity-70'"
                  >
                    {{ labelOf(provider) }}
                  </UiBadge>
                </div>
                <UiTooltip v-if="model.cost" side="left">
                  <span class="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted/50 px-1.5 py-0.5 font-mono text-[10px] font-normal leading-none text-muted-foreground tabular-nums">
                    <UiIcon name="i-lucide-coins" class="size-3" />
                    {{ costSummary(model.cost) }}
                  </span>
                  <template #content>
                    <div class="space-y-0.5">
                      <p class="font-medium">Cost in points per 1M tokens</p>
                      <p v-for="entry in costEntries(model.cost)" :key="entry.label">
                        {{ entry.label }}: {{ costPoints(entry.value) }}
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
                  :stats-map="statsById"
                  :model-id="model.id"
                  :label="model.id"
                  :disabled="!isActive(model)"
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
